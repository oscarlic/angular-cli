/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {
  JsonAstObject,
  JsonObject,
  JsonParseMode,
  json,
  parseJson,
  parseJsonAst,
  workspaces,
} from '@angular-devkit/core';
import { NodeJsSyncHost } from '@angular-devkit/core/node';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findUp } from './find-up';

function isJsonObject(value: json.JsonValue | undefined): value is json.JsonObject {
  return value !== undefined && json.isJsonObject(value);
}

function getSchemaLocation(): string {
  return path.join(__dirname, '../lib/config/schema.json');
}

export const workspaceSchemaPath = getSchemaLocation();

const configNames = [ 'angular.json', '.angular.json' ];
const globalFileName = '.angular-config.json';

function xdgConfigHome(home: string, configFile?: string): string {
  // https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
  const p = process.env['XDG_CONFIG_HOME'] || path.join(home, '.config', 'angular');

  return configFile ? path.join(p, configFile) : p;
}

function projectFilePath(projectPath?: string): string | null {
  // Find the configuration, either where specified, in the Angular CLI project
  // (if it's in node_modules) or from the current process.
  return (
    (projectPath && findUp(configNames, projectPath)) ||
    findUp(configNames, process.cwd()) ||
    findUp(configNames, __dirname)
  );
}

function globalFilePath(): string | null {
  const home = os.homedir();
  if (!home) {
    return null;
  }

  // follow XDG Base Directory spec
  // note that createGlobalSettings() will continue creating
  // global file in home directory, with this user will have
  // choice to move change its location to meet XDG convention
  const xdgConfig = xdgConfigHome(home, globalFileName);
  if (existsSync(xdgConfig)) {
    return xdgConfig;
  }

  const p = path.join(home, globalFileName);
  if (existsSync(p)) {
    return p;
  }

  return null;
}

export class AngularWorkspace {
  readonly basePath: string;

  constructor(private workspace: workspaces.WorkspaceDefinition, readonly filePath: string) {
    this.basePath = path.dirname(filePath);
  }

  get extensions(): Record<string, json.JsonValue | undefined> {
    return this.workspace.extensions;
  }

  get projects(): workspaces.ProjectDefinitionCollection {
    return this.workspace.projects;
  }

  // Temporary helper functions to support refactoring

  // tslint:disable-next-line: no-any
  getCli(): Record<string, any> {
    return (this.workspace.extensions['cli'] as Record<string, unknown>) || {};
  }

  // tslint:disable-next-line: no-any
  getProjectCli(projectName: string): Record<string, any> {
    const project = this.workspace.projects.get(projectName);

    return (project?.extensions['cli'] as Record<string, unknown>) || {};
  }
}

const cachedWorkspaces = new Map<string, AngularWorkspace | null>();

export async function getWorkspace(
  level: 'local' | 'global' = 'local',
): Promise<AngularWorkspace | null> {
  const cached = cachedWorkspaces.get(level);
  if (cached !== undefined) {
    return cached;
  }

  const configPath = level === 'local' ? projectFilePath() : globalFilePath();

  if (!configPath) {
    cachedWorkspaces.set(level, null);

    return null;
  }

  try {
    const result = await workspaces.readWorkspace(
      configPath,
      workspaces.createWorkspaceHost(new NodeJsSyncHost()),
      workspaces.WorkspaceFormat.JSON,
    );

    const workspace = new AngularWorkspace(result.workspace, configPath);
    cachedWorkspaces.set(level, workspace);

    return workspace;
  } catch (error) {
    throw new Error(
      `Workspace config file cannot be loaded: ${configPath}` +
        `\n${error instanceof Error ? error.message : error}`,
    );
  }
}

export function createGlobalSettings(): string {
  const home = os.homedir();
  if (!home) {
    throw new Error('No home directory found.');
  }

  const globalPath = path.join(home, globalFileName);
  writeFileSync(globalPath, JSON.stringify({ version: 1 }));

  return globalPath;
}

export function getWorkspaceRaw(
  level: 'local' | 'global' = 'local',
): [JsonAstObject | null, string | null] {
  let configPath = level === 'local' ? projectFilePath() : globalFilePath();

  if (!configPath) {
    if (level === 'global') {
      configPath = createGlobalSettings();
    } else {
      return [null, null];
    }
  }

  const data = readFileSync(configPath);
  let start = 0;
  if (data.length > 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    // Remove BOM
    start = 3;
  }
  const content = data.toString('utf-8', start);
  const ast = parseJsonAst(content, JsonParseMode.Loose);

  if (ast.kind != 'object') {
    throw new Error(`Invalid JSON file: ${configPath}`);
  }

  return [ast, configPath];
}

export async function validateWorkspace(data: JsonObject): Promise<void> {
  const schemaContent = readFileSync(
    path.join(__dirname, '..', 'lib', 'config', 'schema.json'),
    'utf-8',
  );
  const schema = parseJson(schemaContent, JsonParseMode.Loose) as json.schema.JsonSchema;
  const { formats } = await import('@angular-devkit/schematics');
  const registry = new json.schema.CoreSchemaRegistry(formats.standardFormats);
  const validator = await registry.compile(schema).toPromise();

  const { success, errors } = await validator(data).toPromise();
  if (!success) {
    throw new json.schema.SchemaValidationException(errors);
  }
}

function getProjectByPath(workspace: AngularWorkspace, location: string): string | null {
  const isInside = (base: string, potential: string): boolean => {
    const absoluteBase = path.resolve(workspace.basePath, base);
    const absolutePotential = path.resolve(workspace.basePath, potential);
    const relativePotential = path.relative(absoluteBase, absolutePotential);
    if (!relativePotential.startsWith('..') && !path.isAbsolute(relativePotential)) {
      return true;
    }

    return false;
  };

  const projects = Array.from(workspace.projects)
    .map(([name, project]) => [project.root, name] as [string, string])
    .filter((tuple) => isInside(tuple[0], location))
    // Sort tuples by depth, with the deeper ones first. Since the first member is a path and
    // we filtered all invalid paths, the longest will be the deepest (and in case of equality
    // the sort is stable and the first declared project will win).
    .sort((a, b) => b[0].length - a[0].length);

  if (projects.length === 0) {
    return null;
  } else if (projects.length > 1) {
    const found = new Set<string>();
    const sameRoots = projects.filter((v) => {
      if (!found.has(v[0])) {
        found.add(v[0]);

        return false;
      }

      return true;
    });
    if (sameRoots.length > 0) {
      // Ambiguous location - cannot determine a project
      return null;
    }
  }

  return projects[0][1];
}

export function getProjectByCwd(workspace: AngularWorkspace): string | null {
  if (workspace.projects.size === 1) {
    // If there is only one project, return that one.
    return Array.from(workspace.projects.keys())[0];
  }

  const project = getProjectByPath(workspace, process.cwd());
  if (project) {
    return project;
  }

  const defaultProject = workspace.extensions['defaultProject'];
  if (defaultProject && typeof defaultProject === 'string') {
    // If there is a default project name, return it.
    return defaultProject;
  }

  return null;
}

export async function getConfiguredPackageManager(): Promise<string | null> {
  const getPackageManager = (source: json.JsonValue | undefined): string | undefined => {
    if (isJsonObject(source)) {
      const value = source['packageManager'];
      if (value && typeof value === 'string') {
        return value;
      }
    }
  };

  let result: string | undefined | null;

  const workspace = await getWorkspace('local');
  if (workspace) {
    const project = getProjectByCwd(workspace);
    if (project) {
      result = getPackageManager(workspace.projects.get(project)?.extensions['cli']);
    }

    result = result ?? getPackageManager(workspace.extensions['cli']);
  }

  if (result === undefined) {
    const globalOptions = await getWorkspace('global');
    result = getPackageManager(globalOptions?.extensions['cli']);

    if (!workspace && !globalOptions) {
      // Only check legacy if updated workspace is not found
      result = getLegacyPackageManager();
    }
  }

  // Default to null
  return result ?? null;
}

export function migrateLegacyGlobalConfig(): boolean {
  const homeDir = os.homedir();
  if (homeDir) {
    const legacyGlobalConfigPath = path.join(homeDir, '.angular-cli.json');
    if (existsSync(legacyGlobalConfigPath)) {
      const content = readFileSync(legacyGlobalConfigPath, 'utf-8');
      const legacy = parseJson(content, JsonParseMode.Loose);
      if (!isJsonObject(legacy)) {
        return false;
      }

      const cli: JsonObject = {};

      if (
        legacy.packageManager &&
        typeof legacy.packageManager == 'string' &&
        legacy.packageManager !== 'default'
      ) {
        cli['packageManager'] = legacy.packageManager;
      }

      if (
        isJsonObject(legacy.defaults) &&
        isJsonObject(legacy.defaults.schematics) &&
        typeof legacy.defaults.schematics.collection == 'string'
      ) {
        cli['defaultCollection'] = legacy.defaults.schematics.collection;
      }

      if (isJsonObject(legacy.warnings)) {
        const warnings: JsonObject = {};
        if (typeof legacy.warnings.versionMismatch == 'boolean') {
          warnings['versionMismatch'] = legacy.warnings.versionMismatch;
        }

        if (Object.getOwnPropertyNames(warnings).length > 0) {
          cli['warnings'] = warnings;
        }
      }

      if (Object.getOwnPropertyNames(cli).length > 0) {
        const globalPath = path.join(homeDir, globalFileName);
        writeFileSync(globalPath, JSON.stringify({ version: 1, cli }, null, 2));

        return true;
      }
    }
  }

  return false;
}

// Fallback, check for packageManager in config file in v1.* global config.
function getLegacyPackageManager(): string | null {
  const homeDir = os.homedir();
  if (homeDir) {
    const legacyGlobalConfigPath = path.join(homeDir, '.angular-cli.json');
    if (existsSync(legacyGlobalConfigPath)) {
      const content = readFileSync(legacyGlobalConfigPath, 'utf-8');

      const legacy = parseJson(content, JsonParseMode.Loose);
      if (!isJsonObject(legacy)) {
        return null;
      }

      if (
        legacy.packageManager &&
        typeof legacy.packageManager === 'string' &&
        legacy.packageManager !== 'default'
      ) {
        return legacy.packageManager;
      }
    }
  }

  return null;
}

export async function getSchematicDefaults(
  collection: string,
  schematic: string,
  project?: string | null,
): Promise<{}> {
  const result = {};
  const mergeOptions = (source: json.JsonValue | undefined): void => {
    if (isJsonObject(source)) {
      // Merge options from the qualified name
      Object.assign(result, source[`${collection}:${schematic}`]);

      // Merge options from nested collection schematics
      const collectionOptions = source[collection];
      if (isJsonObject(collectionOptions)) {
        Object.assign(result, collectionOptions[schematic]);
      }
    }
  };

  // Global level schematic options
  const globalOptions = await getWorkspace('global');
  mergeOptions(globalOptions?.extensions['schematics']);

  const workspace = await getWorkspace('local');
  if (workspace) {
    // Workspace level schematic options
    mergeOptions(workspace.extensions['schematics']);

    project = project || getProjectByCwd(workspace);
    if (project) {
      // Project level schematic options
      mergeOptions(workspace.projects.get(project)?.extensions['schematics']);
    }
  }

  return result;
}

export async function isWarningEnabled(warning: string): Promise<boolean> {
  const getWarning = (source: json.JsonValue | undefined): boolean | undefined => {
    if (isJsonObject(source)) {
      const warnings = source['warnings'];
      if (isJsonObject(warnings)) {
        const value = warnings[warning];
        if (typeof value == 'boolean') {
          return value;
        }
      }
    }
  };

  let result: boolean | undefined;

  const workspace = await getWorkspace('local');
  if (workspace) {
    const project = getProjectByCwd(workspace);
    if (project) {
      result = getWarning(workspace.projects.get(project)?.extensions['cli']);
    }

    result = result ?? getWarning(workspace.extensions['cli']);
  }

  if (result === undefined) {
    const globalOptions = await getWorkspace('global');
    result = getWarning(globalOptions?.extensions['cli']);
  }

  // All warnings are enabled by default
  return result ?? true;
}
