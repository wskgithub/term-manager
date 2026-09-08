import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface Profile {
  id: string
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  color?: string
}

const DEFAULT_PROFILES: Profile[] = [
  { id: 'local', name: '本机 Shell', color: '#4fc3f7' },
  { id: 'gpu-27', name: 'GPU 机器', command: 'ssh', args: ['wsk@192.168.0.27'], color: '#aed581' },
  { id: 'win-17', name: 'Windows .17', command: 'ssh', args: ['DELL@192.168.0.17'], color: '#ffcc80' }
]

export class ProfileRegistry {
  private profiles: Profile[] = []
  private file = ''

  load(): void {
    this.file = join(app.getPath('userData'), 'profiles.json')
    if (existsSync(this.file)) {
      this.profiles = JSON.parse(readFileSync(this.file, 'utf-8')) as Profile[]
    } else {
      this.profiles = DEFAULT_PROFILES
      this.save()
    }
  }

  list(): Profile[] {
    return this.profiles
  }

  get(id: string): Profile | undefined {
    return this.profiles.find((p) => p.id === id)
  }

  private save(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.profiles, null, 2))
  }
}
