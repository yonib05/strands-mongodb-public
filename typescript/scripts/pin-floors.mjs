// Installs, or prints the command that installs, the lowest version each peer range in ./package.json admits.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const FLOOR = /^(?:>=|\^)(\d+\.\d+\.\d+)$/

const { peerDependencies = {} } = JSON.parse(readFileSync('package.json', 'utf8'))
if (Object.keys(peerDependencies).length === 0) {
  console.error('error: package.json declares no peerDependencies, so there is no floor to install.')
  process.exit(1)
}

const specs = Object.entries(peerDependencies).map(([name, range]) => {
  const floor = FLOOR.exec(range)?.[1]
  if (floor === undefined) {
    console.error(`error: ${name}@${range} names no single floor; write it as >=x.y.z or ^x.y.z.`)
    process.exit(1)
  }
  return `${name}@${floor}`
})

const args = ['install', '--no-save', ...specs]
if (process.argv.includes('--install')) execFileSync('npm', args, { stdio: 'inherit' })
else console.log(`npm ${args.join(' ')}`)
