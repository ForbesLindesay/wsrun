/**
 * Remove me.
 */

import * as Bromise from 'bluebird'
import chalk from 'chalk'
import * as path from 'path'

import { PkgJson, Dict } from './workspace'
import { uniq } from 'lodash'
import { inherits } from 'util'
import { CmdProcess } from './cmd-process'

type PromiseFn<T> = () => Bromise<T>
type PromiseFnRunner = <T>(f: PromiseFn<T>) => Bromise<T>

let mkThroat = require('throat')(Bromise) as ((limit: number) => PromiseFnRunner)

let passThrough: PromiseFnRunner = f => f()

class Prefixer {
  constructor(private wspath: string) {}
  private currentName = ''
  prefixer = (basePath: string, pkg: string, line: string) => {
    let l = ''
    if (this.currentName != pkg) l += chalk.bold((this.currentName = pkg)) + '\n'
    l += ' | ' + this.processFilePaths(basePath, line)
    return l
  }

  processFilePaths(basePath: string, line: string) {
    return line.replace(/(([^/\s'"*]+[/]){1,})([^/'"*]+)\.[0-9a-zA-Z]{1,6}/, m =>
      path.relative(this.wspath, path.resolve(basePath, m))
    )
  }
}

export interface GraphOptions {
  bin: string
  fastExit: boolean
  collectLogs: boolean
  addPrefix: boolean
  mode: 'parallel' | 'serial' | 'stages'
  recursive: boolean
  doneCriteria: string | undefined
  workspacePath: string
  exclude: string[]
  excludeMissing: boolean
  showReport: boolean
  if: string
  ifDependency: boolean
}

enum ResultSpecialValues {
  Pending = 'PENDING',
  Excluded = 'EXCLUDED',
  MissingScript = 'MISSING_SCRIPT'
}
type Result = number | ResultSpecialValues

enum ProcResolution {
  Normal = 'Normal',
  Missing = 'Missing',
  Excluded = 'Excluded'
}

export class RunGraph {
  private procmap = new Map<string, Bromise<ProcResolution>>()
  children: CmdProcess[]
  finishedAll!: Bromise<CmdProcess[]>
  private jsonMap = new Map<string, PkgJson>()
  private runList = new Set<string>()
  private resultMap = new Map<string, Result>()
  private throat: PromiseFnRunner = passThrough
  prefixer = new Prefixer(this.opts.workspacePath).prefixer

  constructor(
    public pkgJsons: PkgJson[],
    public opts: GraphOptions,
    public pkgPaths: Dict<string>
  ) {
    this.checkResultsAndReport = this.checkResultsAndReport.bind(this)
    this.closeAll = this.closeAll.bind(this)

    pkgJsons.forEach(j => this.jsonMap.set(j.name, j))
    this.children = []
    if (this.opts.mode === 'serial') this.throat = mkThroat(1)
    if (this.opts.mode === 'stages') this.throat = mkThroat(16) // max 16 proc

    process.on('SIGINT', this.closeAll) // close all children on ctrl+c
  }

  private closeAll = () => {
    console.log('Stopping', this.children.length, 'active children')
    this.children.forEach(ch => ch.stop())
  }

  private lookupOrRun(cmd: string[], pkg: string): Bromise<ProcResolution> {
    let proc = this.procmap.get(pkg)
    if (proc == null) {
      proc = Bromise.resolve().then(() => this.runOne(cmd, pkg))
      this.procmap.set(pkg, proc)
      return proc
    }
    return proc
  }

  private allDeps(pkg: PkgJson) {
    let findMyDeps = uniq(
      Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}))
    ).filter(d => this.jsonMap.has(d) && (this.opts.recursive || this.runList.has(d)))
    return findMyDeps
  }

  detectCycles() {
    let topLevelPkgs: { [name: string]: any } = {}
    for (let key of this.jsonMap.keys()) {
      topLevelPkgs[key] = '*'
    }
    let top = { name: '$', dependencies: topLevelPkgs }
    let self = this
    function deepCycle(json: PkgJson, pathLookup: string[]): string[] {
      let newPathLookup = pathLookup.concat([json.name])
      let index = pathLookup.indexOf(json.name)
      if (index >= 0) {
        return newPathLookup.slice(index)
      }
      let currentDeps = Object.keys(json.dependencies || {}).concat(
        Object.keys(json.devDependencies || {})
      )
      for (let name of currentDeps) {
        let d = self.jsonMap.get(name)
        if (!d) continue
        let res = deepCycle(d, newPathLookup)
        if (res.length) return res
      }
      return []
    }
    let res = deepCycle(top, [])
    return res
  }

  private makeCmd(cmd: string[]) {
    return [this.opts.bin].concat(cmd)
  }

  private runCondition(cmd: string, pkg: string) {
    let cmdLine = this.makeCmd(cmd.split(' '))
    const child = new CmdProcess(cmdLine, pkg, {
      rejectOnNonZeroExit: false,
      silent: true,
      collectLogs: this.opts.collectLogs,
      prefixer: this.opts.addPrefix ? this.prefixer : undefined,
      doneCriteria: this.opts.doneCriteria,
      path: this.pkgPaths[pkg]
    })
    let rres = child.exitCode.then(code => code === 0)
    child.start()
    return rres
  }

  private runOne(cmdArray: string[], pkg: string): Bromise<ProcResolution> {
    let p = this.jsonMap.get(pkg)
    if (p == null) throw new Error('Unknown package: ' + pkg)
    let myDeps = Bromise.all(this.allDeps(p).map(d => this.lookupOrRun(cmdArray, d)))

    return myDeps.then(depsStatuses => {
      this.resultMap.set(pkg, ResultSpecialValues.Pending)

      if (this.opts.exclude.indexOf(pkg) >= 0) {
        console.log(chalk.bold(pkg), 'in exclude list, skipping')
        this.resultMap.set(pkg, ResultSpecialValues.Excluded)
        return Bromise.resolve(ProcResolution.Excluded)
      }
      if (this.opts.excludeMissing && (!p || !p.scripts || !p.scripts[cmdArray[0]])) {
        console.log(chalk.bold(pkg), 'has no ', cmdArray[0], 'script, skipping missing')
        this.resultMap.set(pkg, ResultSpecialValues.MissingScript)
        return Bromise.resolve(ProcResolution.Missing)
      }

      let ifCondtition = Bromise.resolve(true)

      if (
        this.opts.if &&
        (!this.opts.ifDependency || !depsStatuses.find(ds => ds === ProcResolution.Normal))
      ) {
        ifCondtition = this.runCondition(this.opts.if, pkg)
      }

      let finished = ifCondtition.then(shouldExecute => {
        if (!shouldExecute) {
          this.resultMap.set(pkg, ResultSpecialValues.Excluded)
          return Bromise.resolve(ProcResolution.Excluded)
        }

        let cmdLine = this.makeCmd(cmdArray)
        const child = new CmdProcess(cmdLine, pkg, {
          rejectOnNonZeroExit: this.opts.fastExit,
          collectLogs: this.opts.collectLogs,
          prefixer: this.opts.addPrefix ? this.prefixer : undefined,
          doneCriteria: this.opts.doneCriteria,
          path: this.pkgPaths[pkg]
        })
        child.exitCode.then(code => this.resultMap.set(pkg, code))
        this.children.push(child)

        return this.throat(() => {
          child.start()
          return child.finished.thenReturn(ProcResolution.Normal)
        })
      })

      if (this.opts.mode === 'parallel') finished = Bromise.resolve(ProcResolution.Normal)
      return finished
    })
  }

  private checkResultsAndReport(cmdLine: string[], pkgs: string[]) {
    let cmd = cmdLine.join(' ')
    const pkgsInError: string[] = []
    const pkgsSuccessful: string[] = []
    const pkgsPending: string[] = []
    const pkgsSkipped: string[] = []
    const pkgsMissingScript: string[] = []

    this.resultMap.forEach((result, pkg) => {
      switch (result) {
        case ResultSpecialValues.Excluded:
          pkgsSkipped.push(pkg)
          break

        case ResultSpecialValues.MissingScript:
          pkgsMissingScript.push(pkg)
          break

        case ResultSpecialValues.Pending:
          pkgsPending.push(pkg)
          break

        case 0:
          pkgsSuccessful.push(pkg)
          break

        default:
          pkgsInError.push(pkg)
          break
      }
    })

    if (this.opts.showReport) {
      const formatPkgs = (pgks: string[]): string => pgks.join(', ')
      const pkgsNotStarted = pkgs.filter(pkg => !this.resultMap.has(pkg))

      console.log(chalk.bold('\nReport:'))

      if (pkgsInError.length)
        console.log(
          chalk.red(
            `  ${pkgsInError.length} packages finished \`${cmd}\` with error: ${formatPkgs(
              pkgsInError
            )}`
          )
        )
      if (pkgsSuccessful.length)
        console.log(
          chalk.green(
            `  ${pkgsSuccessful.length} packages finished \`${cmd}\` successfully: ${formatPkgs(
              pkgsSuccessful
            )}`
          )
        )
      if (pkgsPending.length)
        console.log(
          chalk.white(
            `  ${pkgsPending.length} packages have been cancelled running \`${cmd}\`: ${formatPkgs(
              pkgsPending
            )}`
          )
        )
      if (pkgsNotStarted.length)
        console.log(
          chalk.white(
            `  ${pkgsNotStarted.length} packages have not started running \`${cmd}\`: ${formatPkgs(
              pkgsNotStarted
            )}`
          )
        )
      if (pkgsMissingScript.length)
        console.log(
          chalk.gray(
            `  ${pkgsMissingScript.length} packages are missing script \`${cmd}\`: ${formatPkgs(
              pkgsMissingScript
            )}`
          )
        )
      if (pkgsSkipped.length)
        console.log(
          chalk.gray(
            `  ${pkgsSkipped.length} packages have been skipped: ${formatPkgs(pkgsSkipped)}`
          )
        )

      console.log()
    }

    return pkgsInError.length > 0
  }

  run(cmd: string[], pkgs: string[] = this.pkgJsons.map(p => p.name)) {
    this.runList = new Set(pkgs)
    return Bromise.all(pkgs.map(pkg => this.lookupOrRun(cmd, pkg)))
      .then(() => Bromise.all(this.children.map(c => c.exitError)))
      .catch(err => this.opts.fastExit && this.closeAll())
      .then(() => this.checkResultsAndReport(cmd, pkgs))
  }
}