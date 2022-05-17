import os from 'os'
import chokidar from 'chokidar'
import type { ResolvedFromConfig, RESOLVED_FROM, FoundSpec, TestingType } from '@packages/types'
import minimatch from 'minimatch'
import { debounce, isEqual } from 'lodash'
import path from 'path'
import Debug from 'debug'
import commonPathPrefix from 'common-path-prefix'
import type { FSWatcher } from 'chokidar'
import { defaultSpecPattern } from '@packages/config'
import parseGlob from 'parse-glob'
import mm from 'micromatch'
import RandExp from 'randexp'

const debug = Debug('cypress:data-context')
import assert from 'assert'

import type { DataContext } from '..'
import { toPosix } from '../util/file'
import type { FilePartsShape } from '@packages/graphql/src/schemaTypes/objectTypes/gql-FileParts'

export type SpecWithRelativeRoot = FoundSpec & { relativeToCommonRoot: string }

interface MatchedSpecs {
  projectRoot: string
  testingType: Cypress.TestingType
  specAbsolutePaths: string[]
  specPattern: string | string[]
}
export function matchedSpecs ({
  projectRoot,
  testingType,
  specAbsolutePaths,
}: MatchedSpecs): SpecWithRelativeRoot[] {
  debug('found specs %o', specAbsolutePaths)

  let commonRoot: string = ''

  if (specAbsolutePaths.length === 1) {
    commonRoot = path.dirname(specAbsolutePaths[0]!)
  } else {
    commonRoot = commonPathPrefix(specAbsolutePaths)
  }

  const specs = specAbsolutePaths.map((absolute) => {
    return transformSpec({ projectRoot, absolute, testingType, commonRoot, platform: os.platform(), sep: path.sep })
  })

  return specs
}

export interface TransformSpec {
  projectRoot: string
  absolute: string
  testingType: Cypress.TestingType
  commonRoot: string
  platform: NodeJS.Platform
  sep: string
}

export function transformSpec ({
  projectRoot,
  absolute,
  testingType,
  commonRoot,
  platform,
  sep,
}: TransformSpec): SpecWithRelativeRoot {
  if (platform === 'win32') {
    absolute = toPosix(absolute, sep)
    projectRoot = toPosix(projectRoot, sep)
  }

  const relative = path.relative(projectRoot, absolute)
  const parsedFile = path.parse(absolute)
  const fileExtension = path.extname(absolute)

  const specFileExtension = ['.spec', '.test', '-spec', '-test', '.cy']
  .map((ext) => ext + fileExtension)
  .find((ext) => absolute.endsWith(ext)) || fileExtension

  const parts = absolute.split(projectRoot)
  let name = parts[parts.length - 1] || ''

  if (name.startsWith('/')) {
    name = name.slice(1)
  }

  const LEADING_SLASH = /^\/|/g
  const relativeToCommonRoot = absolute.replace(commonRoot, '').replace(LEADING_SLASH, '')

  return {
    fileExtension,
    baseName: parsedFile.base,
    fileName: parsedFile.base.replace(specFileExtension, ''),
    specFileExtension,
    relativeToCommonRoot,
    specType: testingType === 'component' ? 'component' : 'integration',
    name,
    relative,
    absolute,
  }
}

export function getLongestCommonPrefixFromPaths (paths: string[]): string {
  if (!paths[0]) return ''

  function getPathParts (pathname: string) {
    return pathname.split(/[\/\\]/g)
  }

  const lcp = getPathParts(paths[0])

  if (paths.length === 1) return lcp.slice(0, -1).join(path.sep)

  let end = lcp.length

  for (const filename of paths.slice(1)) {
    const pathParts = getPathParts(filename)

    for (let i = pathParts.length - 1; i >= 0; i--) {
      if (lcp[i] !== pathParts[i]) {
        end = i
        delete lcp[i]
      }
    }

    if (lcp.length === 0) return ''
  }

  return lcp.slice(0, end).join(path.sep)
}

export function getLongestCommonPrefixFromGlob (inputGlob: string, testingType: TestingType, fileExtensionToUse?: 'js' | 'ts') {
  function replaceWildCard (s: string, fallback: string) {
    return s.replace(/\*/g, fallback)
  }

  const parsedGlob = parseGlob(inputGlob)

  if (!parsedGlob.is.glob) {
    return inputGlob
  }

  let dirname = parsedGlob.path.dirname

  if (dirname.startsWith('**')) {
    dirname = dirname.replace('**', 'cypress')
  }

  const splittedDirname = dirname.split('/').filter((s) => s !== '**').map((x) => replaceWildCard(x, testingType)).join('/')
  const fileName = replaceWildCard(parsedGlob.path.filename, 'filename')

  const extnameWithoutExt = parsedGlob.path.extname.replace(parsedGlob.path.ext, '')
  let extname = replaceWildCard(extnameWithoutExt, 'cy')

  if (extname.startsWith('.')) {
    extname = extname.substr(1)
  }

  if (extname.endsWith('.')) {
    extname = extname.slice(0, -1)
  }

  const basename = [fileName, extname, parsedGlob.path.ext].filter(Boolean).join('.')

  const glob = splittedDirname + basename

  const globWithoutBraces = mm.braces(glob, { expand: true })

  let finalGlob = globWithoutBraces[0]

  if (fileExtensionToUse) {
    const filteredGlob = mm(globWithoutBraces, `*.${fileExtensionToUse}`, { basename: true })

    if (filteredGlob?.length) {
      finalGlob = filteredGlob[0]
    }
  }

  if (!finalGlob) {
    return
  }

  const randExp = new RandExp(finalGlob.replace(/\./g, '\\.'))

  return randExp.gen()
}

export class ProjectDataSource {
  private _specWatcher: FSWatcher | null = null
  private _specs: FoundSpec[] = []

  constructor (private ctx: DataContext) {}

  private get api () {
    return this.ctx._apis.projectApi
  }

  projectId () {
    return this.ctx.lifecycleManager.getProjectId()
  }

  projectTitle (projectRoot: string) {
    return path.basename(projectRoot)
  }

  async getConfig () {
    return await this.ctx.lifecycleManager.getFullInitialConfig()
  }

  getCurrentProjectSavedState () {
    return this.api.getCurrentProjectSavedState()
  }

  get specs () {
    return this._specs
  }

  setSpecs (specs: FoundSpec[]) {
    this._specs = specs
  }

  setRelaunchBrowser (relaunchBrowser: boolean) {
    this.ctx.coreData.app.relaunchBrowser = relaunchBrowser
  }

  async specPatterns (): Promise<{
    specPattern?: string[]
    excludeSpecPattern?: string[]
  }> {
    const toArray = (val?: string | string[]) => val ? typeof val === 'string' ? [val] : val : undefined

    const config = await this.getConfig()

    return {
      specPattern: toArray(config.specPattern),
      excludeSpecPattern: toArray(config.excludeSpecPattern),
    }
  }

  async findSpecs (
    projectRoot: string,
    testingType: Cypress.TestingType,
    specPattern: string[],
    excludeSpecPattern: string[],
    globToRemove: string[],
  ): Promise<FoundSpec[]> {
    const specAbsolutePaths = await this.ctx.file.getFilesByGlob(
      projectRoot,
      specPattern, {
        absolute: true,
        ignore: [...excludeSpecPattern, ...globToRemove],
      },
    )

    const matched = matchedSpecs({
      projectRoot,
      testingType,
      specAbsolutePaths,
      specPattern,
    })

    return matched
  }

  startSpecWatcher (
    projectRoot: string,
    testingType: Cypress.TestingType,
    specPattern: string[],
    excludeSpecPattern: string[],
    additionalIgnore: string[],
  ) {
    this.stopSpecWatcher()

    const currentProject = this.ctx.currentProject

    if (!currentProject) {
      throw new Error('Cannot start spec watcher without current project')
    }

    // When file system changes are detected, we retrieve any spec files matching
    // the determined specPattern. This function is debounced to limit execution
    // during sequential file operations.
    const onProjectFileSystemChange = debounce(async () => {
      const specs = await this.findSpecs(projectRoot, testingType, specPattern, excludeSpecPattern, additionalIgnore)

      if (isEqual(this.specs, specs)) {
        this.ctx.actions.project.refreshSpecs(specs)

        // If no differences are found, we do not need to emit events
        return
      }

      this.ctx.actions.project.setSpecs(specs)
    }, 250)

    // We respond to all changes to the project's filesystem when
    // files or directories are added and removed that are not explicitly
    // ignored by config
    this._specWatcher = chokidar.watch('.', {
      ignoreInitial: true,
      cwd: projectRoot,
      ignored: ['**/node_modules/**', ...excludeSpecPattern, ...additionalIgnore],
    })

    // the 'all' event includes: add, addDir, change, unlink, unlinkDir
    this._specWatcher.on('all', onProjectFileSystemChange)
  }

  async defaultSpecFileName (): Promise<string | null> {
    const defaultFilename = `cypress/${this.ctx.coreData.currentTestingType}/filename.cy.${this.ctx.lifecycleManager.fileExtensionToUse}/`

    try {
      if (!this.ctx.currentProject || !this.ctx.coreData.currentTestingType) {
        return null
      }

      let specPatternSet: string | undefined
      const { specPattern = [] } = await this.ctx.project.specPatterns()

      if (Array.isArray(specPattern)) {
        specPatternSet = specPattern[0]
      }

      // 1. If there is no spec pattern, use the default for this testing type.
      if (!specPatternSet) {
        return defaultFilename
      }

      // 2. If the spec pattern is the default spec pattern, return the default for this testing type.
      if (specPatternSet === defaultSpecPattern[this.ctx.coreData.currentTestingType]) {
        return defaultFilename
      }

      // 3. If there are existing specs, return the longest common path prefix between them, if it is non-empty.
      const filenameFromSpecs = getLongestCommonPrefixFromPaths(this.specs.map((spec) => spec.relative))

      if (filenameFromSpecs) return filenameFromSpecs

      // 4. Otherwise, return the longest possible prefix according to the spec pattern.
      const filenameFromGlob = getLongestCommonPrefixFromGlob(specPatternSet, this.ctx.coreData.currentTestingType, this.ctx.lifecycleManager.fileExtensionToUse)

      if (filenameFromGlob) return filenameFromGlob

      // 5. Return the default for this testing type if we cannot decide from the spec pattern.
      return defaultFilename
    } catch (err) {
      debug('Error intelligently detecting default filename, using safe default %o', err)

      return defaultFilename
    }
  }

  async matchesSpecPattern (specFile: string): Promise<boolean> {
    if (!this.ctx.currentProject || !this.ctx.coreData.currentTestingType) {
      return false
    }

    const MINIMATCH_OPTIONS = { dot: true, matchBase: true }

    const { specPattern = [], excludeSpecPattern = [] } = await this.ctx.project.specPatterns()

    for (const pattern of excludeSpecPattern) {
      if (minimatch(specFile, pattern, MINIMATCH_OPTIONS)) {
        return false
      }
    }

    for (const pattern of specPattern) {
      if (minimatch(specFile, pattern, MINIMATCH_OPTIONS)) {
        return true
      }
    }

    return false
  }

  destroy () {
    this.stopSpecWatcher()
  }

  stopSpecWatcher () {
    if (!this._specWatcher) {
      return
    }

    this._specWatcher.close().catch(() => {})
    this._specWatcher = null
  }

  getCurrentSpecByAbsolute (absolute: string) {
    return this.ctx.project.specs.find((x) => x.absolute === absolute)
  }

  async getProjectPreferences (projectTitle: string) {
    const preferences = await this.api.getProjectPreferencesFromCache()

    return preferences[projectTitle] ?? null
  }

  async getResolvedConfigFields (): Promise<ResolvedFromConfig[]> {
    const config = this.ctx.lifecycleManager.loadedFullConfig?.resolved ?? {}

    interface ResolvedFromWithField extends ResolvedFromConfig {
      field: typeof RESOLVED_FROM[number]
    }

    const mapEnvResolvedConfigToObj = (config: ResolvedFromConfig): ResolvedFromWithField => {
      return Object.entries(config).reduce<ResolvedFromWithField>((acc, [field, value]) => {
        return {
          ...acc,
          value: { ...acc.value, [field]: value.value },
        }
      }, {
        value: {},
        field: 'env',
        from: 'env',
      })
    }

    return Object.entries(config ?? {}).map(([key, value]) => {
      if (key === 'env' && value) {
        return mapEnvResolvedConfigToObj(value)
      }

      return { ...value, field: key }
    }) as ResolvedFromConfig[]
  }

  async getCodeGenCandidates (glob: string): Promise<FilePartsShape[]> {
    if (!glob.startsWith('**/')) {
      glob = `**/${glob}`
    }

    const projectRoot = this.ctx.currentProject

    if (!projectRoot) {
      throw Error(`Cannot find components without currentProject.`)
    }

    const codeGenCandidates = await this.ctx.file.getFilesByGlob(projectRoot, glob, { expandDirectories: true })

    return codeGenCandidates.map((absolute) => ({ absolute }))
  }

  async getIsDefaultSpecPattern () {
    assert(this.ctx.currentProject)
    assert(this.ctx.coreData.currentTestingType)

    const { e2e, component } = defaultSpecPattern

    const { specPattern } = await this.ctx.project.specPatterns()

    if (this.ctx.coreData.currentTestingType === 'e2e') {
      return isEqual(specPattern, [e2e])
    }

    return isEqual(specPattern, [component])
  }
}
