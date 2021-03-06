import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { Answers, initPrompts } from '$/common/prompts'
import { generate } from './generate'
import { setStatus } from './status'
import { completed } from './completed'
import { getClientPort, getServerPort } from './getServerPort'
import stream from 'stream'
import realExecutablePath from 'real-executable-path'
import { canContinueOnPath, getPathStatus } from './localPath'

const dirPath = path.join(homedir(), '.frourio')
const dbPath = path.join(dirPath, 'create-frourio-app.json')

type Schemas = [
  { ver: 1; answers: Omit<Answers, 'client'> & { front?: string } },
  { ver: 2; answers: Answers }
]

let db: Schemas[1]

const migration = [
  {
    ver: 2,
    handler: ({ answers: { front, ...others } }: Schemas[0]): Schemas[1] => ({
      ver: 2,
      answers: { ...others, client: front }
    })
  }
]

export const cliMigration = [
  {
    when: (answers: Schemas[number]['answers']) => 'front' in answers,
    warn: 'Use "client" instead of "front".',
    handler: ({
      front,
      ...others
    }: Schemas[0]['answers']): Schemas[1]['answers'] => ({
      ...others,
      client: front
    })
  }
]

try {
  const tmp = JSON.parse(fs.readFileSync(dbPath, 'utf8'))

  db =
    tmp.ver > migration.length
      ? tmp
      : migration
          .slice(migration.findIndex((m) => m.ver === tmp.ver + 1))
          .reduce((prev, current) => current.handler(prev), tmp)
} catch (e: unknown) {
  db = { ver: 2, answers: {} }
}

export const genAllAnswers = (answers: Answers) =>
  initPrompts(answers).reduce(
    (prev, current) => ({
      ...prev,
      [current.name]: answers[current.name] ?? current.default
    }),
    {} as Answers
  )

const installApp = async (answers: Answers, s: stream.Writable) => {
  setStatus('installing')
  const allAnswers = genAllAnswers(answers)
  const dir = allAnswers.dir ?? ''

  await generate(
    {
      ...allAnswers,
      clientPort: await getClientPort(),
      serverPort: await getServerPort()
    },
    __dirname
  )

  await completed(allAnswers, s)
  const npmClientPath = await realExecutablePath(answers.pm ?? 'npm')

  const npmRun = (script: string) =>
    new Promise((resolve, reject) => {
      const proc = spawn(npmClientPath, ['run', '--color', script], {
        cwd: path.resolve(dir),
        stdio: ['inherit', 'pipe', 'pipe'],
        env: {
          FORCE_COLOR: 'true',
          /* eslint-disable camelcase */
          npm_config_color: 'always',
          npm_config_progress: 'true',
          /* eslint-enable camelcase */
          ...process.env
        }
      })
      proc.stdio[1]?.on('data', s.write.bind(s))
      proc.stdio[2]?.on('data', s.write.bind(s))
      proc.once('close', resolve)
      proc.once('error', reject)
    })

  await npmRun('generate')
  await npmRun('lint:fix')
  if (answers.skipDbChecks !== 'true') {
    if (answers.orm === 'prisma') {
      await npmRun('migrate:dev')
    } else if (answers.orm === 'typeorm') {
      await npmRun('migration:run')
    }
  }

  npmRun('dev')

  delete db.answers.dir
  delete db.answers.dbName
  delete db.answers.dbPass
  await fs.promises.writeFile(dbPath, JSON.stringify(db), 'utf8')
}

export const getAnswers = () => ({
  dir: process.argv[2],
  ...db.answers
})

export const updateAnswers = async (answers: Answers, s: stream.Writable) => {
  db = { ...db, answers: { ...answers, dbPass: undefined } }

  const canContinue = canContinueOnPath(
    await getPathStatus(path.resolve(process.cwd(), answers.dir || ''))
  )
  if (canContinue !== null) {
    throw new Error(canContinue)
  }

  if (!fs.existsSync(dirPath)) await fs.promises.mkdir(dirPath)

  await fs.promises.writeFile(dbPath, JSON.stringify(db), 'utf8')

  return await installApp(answers, s)
}
