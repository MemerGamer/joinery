/**
 * Directory listing for the web folder picker. Names and paths of
 * directories only — never file names or contents.
 */
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { DirEntry } from '@joinery/core';
import { badRequest, pathError } from '../http/errors.ts';

export interface DirListing {
  path: string;
  parent: string | null;
  isRepo: boolean;
  entries: DirEntry[];
}

/** `.git` is a directory in a clone, a file in a worktree or submodule. */
async function hasGit(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function listDirs(rawPath: string | undefined, hidden: boolean): Promise<DirListing> {
  let wanted = rawPath === undefined || rawPath === '' ? homedir() : rawPath;
  if (wanted === '~' || wanted.startsWith('~/')) wanted = join(homedir(), wanted.slice(1));
  if (!isAbsolute(wanted)) throw badRequest(`path must be absolute, got: ${wanted}`);

  let path: string;
  try {
    path = await realpath(wanted);
  } catch (err) {
    throw pathError(err, wanted);
  }
  if (!(await isDir(path))) throw badRequest(`not a directory: ${wanted}`);

  let children;
  try {
    children = await readdir(path, { withFileTypes: true });
  } catch (err) {
    throw pathError(err, path);
  }

  const entries = (
    await Promise.all(
      children.map(async (child): Promise<DirEntry | null> => {
        if (!hidden && child.name.startsWith('.')) return null;
        const full = join(path, child.name);
        if (!child.isDirectory() && !(child.isSymbolicLink() && (await isDir(full)))) return null;
        return { name: child.name, path: full, isRepo: await hasGit(full) };
      }),
    )
  ).filter((e): e is DirEntry => e !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, isRepo: await hasGit(path), entries };
}
