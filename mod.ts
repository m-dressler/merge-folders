import { crypto } from "@std/crypto";
import { iterateReader } from "@std/io/iterate-reader";
import { walk, type WalkEntry } from "@std/fs/walk";
import { resolve } from "@std/path/resolve";

/** Calculates a files unique hash using SHA256 */
const calcHash = async (path: string): Promise<Uint8Array> => {
  using  file = await Deno.open(path);
  /** Can assert Uint32Array as SHA-256 returns 256 bits = 8 * 32 bits */
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", iterateReader(file))
  );
};

/** Checks if the contents of {@see path1 } and {@see path2 } have the same hash */
const sameHash = async (path1: string, path2: string) => {
  const hash1Promise = calcHash(path1);
  const hash2 = await calcHash(path2);
  const hash1 = await hash1Promise;

  for (let i = 0; i < hash1.length; ++i)
    if (hash1[i] !== hash2[i]) return false;
  return true;
};

/** Cleans a folder recursively for each folder without non-folder children */
const removeEmptyFolders = async (folder: string) => {
  const { isDirectory } = await Deno.stat(folder);
  if (!isDirectory) throw new Error("Provided path is not a directory");

  /** If the current folder is empty */
  let isEmpty = true;

  const files = Deno.readDir(folder);
  for await (const entry of files) {
    const fullPath = resolve(folder, entry.name);

    // If there is at least one file, this directory is not empty
    if (!entry.isDirectory) isEmpty = false;
    // If it's a directory and not empty, neither is this folder
    else if (!(await removeEmptyFolders(fullPath))) isEmpty = false;
  }

  // If it is empty, remove this folder
  if (isEmpty) await Deno.remove(folder);

  return isEmpty;
};

/** Walks a directory like {@see walk } but converts the {@see WalkEntry.name } property to the local path within the directory */
const directoryWalk = async (directory: string): Promise<WalkEntry[]> => {
  const entries: WalkEntry[] = [];
  for await (const entry of walk(directory)) {
    // If entry is the root directory entry, skip it
    if (entry.path === directory) continue;
    // Remove the directory path plus the slash
    entry.name = entry.path.substring(directory.length + 1);
    entries.push(entry);
  }
  return entries;
};

/** 
 * Merges contents from {@see toMerge } into {@see target }
 *
 * @returns All the entries which had merge conflicts 
 */
export const mergeFolders = async (target: string, toMerge: string): Promise<WalkEntry[]> => {
  // This function iteratively traverses each folder/filer in `folder1`
  // and merges its content into the equivalent folder in `folder2` or
  // moves it there if no equivalent exists

  target = resolve(target);
  toMerge = resolve(toMerge);

  if (target === toMerge)
    throw new Error("Merge folder cannot be the same as merge target");
  if (target.startsWith(toMerge) || toMerge.startsWith(target))
    throw new Error(
      "Target and merge folders cannot be children of each other"
    );

  /** Promise of all toMerge's children (not awaited yet for parallelism) */
  const mergeChildrenPromise = directoryWalk(toMerge);
  /** All the target's children */
  const targetChildren = await directoryWalk(target);
  /** All the files to merge into the new folder */
  const mergeChildren = await mergeChildrenPromise;

  /** A dictionary of target children names to their full entries */
  const targetDirectory = Object.fromEntries(
    targetChildren.map((c) => [c.name, c])
  );

  /** Any files which are present in folder1 and folder2 but have different hashes */
  const conflicts: WalkEntry[] = [];

  for (let i = 0; i < mergeChildren.length; ++i) {
    const mergeChild = mergeChildren[i];
    const targetChild = targetDirectory[mergeChild.name];

    // If targetChild doesn't exist, just move it as it's net new
    if (!targetChild) {
      // If it is a directory, skip its children as they don't need to be merged
      if (mergeChild.isDirectory) {
        // Check if the path starts with the directories path and remove if so
        while (mergeChildren[i + 1]?.name.startsWith(mergeChild.name))
          mergeChildren.splice(i + 1, 1);
      }
      const newPath = resolve(target, mergeChild.name);
      await Deno.rename(mergeChild.path, newPath);
    } else if (mergeChild.isDirectory && targetChild.isDirectory) {
      // If both are directories, we can ignore it
    }
    // If both are files, check if they are the same and can be merged
    else if (mergeChild.isFile && targetChild.isFile) {
      const sameFile = await sameHash(mergeChild.path, targetChild.path);
      // If they are the same, delete merge child as it already exists
      if (sameFile) await Deno.remove(mergeChild.path);
      // Otherwise return as conflict
      else conflicts.push(targetChild);
    }
    // If they are different types, return as conflict
    else conflicts.push(targetChild);
  }

  // Clean `toMerge` of empty directories
  await removeEmptyFolders(toMerge);

  return conflicts;
};
