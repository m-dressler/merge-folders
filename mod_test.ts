import { exists } from "@std/fs/exists";
import { mergeFolders } from "./mod.ts";
import { SEPARATOR } from "@std/path";
import { assertEquals, assertRejects } from "@std/assert";

/** Permissions required to run the tests */
const permissions: Deno.PermissionOptions = {
  read: ["."],
  write: [".target", ".toMerge"],
};

/** An entry in the test directory to create */
type TestPath<T extends "raw" | "full" = "full"> = {
  /**
   * If this path should be in the target directory
   *
   * Assumed true if not defined
   */
  target?: false;
  /**
   * If this path should be in the toMerge directory
   *
   * Assumed true if not defined
   */
  toMerge?: false;
} & (
  | {
      /** The path should be a file */
      type: "file";
      /**
       * If the file should be the same in the target and toMerge directory
       *
       * Assumed false if not defined
       */
      conflict?: true;
    }
  | {
      /** The path should be a directory */
      type: "dir";
      /** The children of the directory */
      children: TestPath<T>[];
    }
) &
  (T extends "full"
    ? {
        /** The local directory path to the file */
        path: string;
      }
    : // deno-lint-ignore ban-types
      {});

/** Details about unexpected results during the merge operation */
type MergeError = {
  path: string;
  error:
    | "MISSING"
    | "OVERWRITTEN"
    | "CONFLICT_MISSING"
    | "UNREPORTED_CONFLICT"
    | "BAD_REPORTED_CONFLICT";
};

/** Constant string to append to file contents if file is expected to be a merge conflict */
const conflictPostfix = " - CONFLICT";

/** Recursively converts `TestPath<raw>`s to `TestPath<full>`s by adding the path via the index of the TestPath */
const covertToFullPaths = (
  rawTestPaths: TestPath<"raw">[],
  parentInfo = {
    path: "",
    inMerge: true,
    inTarget: true,
  }
): TestPath[] => {
  const testPaths: TestPath[] = [];
  for (let i = 0; i < rawTestPaths.length; ++i) {
    const entry = rawTestPaths[i];
    const isDir = entry.type === "dir";
    const path = parentInfo.path + i + (isDir ? SEPARATOR : "");
    // Propagate not in merge to children
    if (!parentInfo.inMerge) entry.toMerge = false;
    if (!parentInfo.inTarget) entry.target = false;
    const fullEntry: TestPath = isDir
      ? Object.assign(entry, {
          children: covertToFullPaths(entry.children, {
            path,
            inMerge: entry.toMerge !== false,
            inTarget: entry.target !== false,
          }),
          path,
        })
      : Object.assign(entry, { path });
    testPaths.push(fullEntry);
  }
  return testPaths;
};

/** The test directory to create for testing the merge */
const testDirectory = covertToFullPaths([
  /** This file is the same so it should NOT cause a conflict */
  { type: "file" },
  /** This file is different so it should cause a conflict */
  { type: "file", conflict: true },
  /** A directory without any conflicts */
  {
    type: "dir",
    children: [
      { type: "file" },
      { type: "file" },
      {
        type: "dir",
        children: [{ type: "file" }, { type: "file" }],
      },
    ],
  },
  /** A directory that only exists in the target directory */
  {
    type: "dir",
    toMerge: false,
    children: [
      { type: "file" },
      /** This file is different but it only exists in target so it shouldn't matter */
      { type: "file", conflict: true },
      {
        type: "dir",
        children: [
          /** This file is different but it only exists in target so it shouldn't matter */
          { type: "file", conflict: true },
          { type: "file" },
        ],
      },
    ],
  },
  /** A directory that only exists in the merge directory */
  {
    type: "dir",
    target: false,
    children: [
      { type: "file" },
      /** This file is different but it only exists in merge so it shouldn't matter */
      { type: "file", conflict: true },
      {
        type: "dir",
        children: [
          /** This file is different but it only exists in merge so it shouldn't matter */
          { type: "file", conflict: true },
          { type: "file" },
        ],
      },
    ],
  },
  /** A directory with conflicts */
  {
    type: "dir",
    children: [
      /** This file is the same so it should NOT cause a conflict */
      { type: "file" },
      /** This file is different so it should cause a conflict */
      { type: "file", conflict: true },
      {
        type: "dir",
        children: [
          /** This file is different but it only exists in merge so it shouldn't matter */
          { type: "file", conflict: true },
          /** This file is the same so it should NOT cause a conflict */
          { type: "file" },
        ],
      },
    ],
  },
]);

/** Creates the directory for the target and toMerge directories based on the {@see testDir } */
const createDir = async (type: "target" | "toMerge"): Promise<string> => {
  const rootDir = "." + type;
  /** Creates the root directory */
  await Deno.mkdir(rootDir);

  const createEntries = async (entries: TestPath[]) => {
    // Add all items of `toAddStack`
    for (const entry of entries) {
      // If the path should not be added to this directory type, continue
      if (entry[type] === false) continue;

      const path = rootDir + SEPARATOR + entry.path;

      if (entry.type === "file") {
        /** The file content to add */
        let content = entry.path;
        // If it should be different, add a content difference in the `toMerge` file
        if (entry.conflict && type === "toMerge") content += conflictPostfix;
        // Create the file
        await Deno.writeTextFile(path, content);
      } else {
        // Create the directory and add all files
        await Deno.mkdir(path);
        // Create all subentries
        await createEntries(entry.children);
      }
    }
  };

  await createEntries(testDirectory);

  return rootDir;
};

Deno.test({
  name: "Same directory error",
  fn: () => {
    assertRejects(
      () => mergeFolders("fake/dir", "fake/dir"),
      Error,
      "Merge folder cannot be the same as merge target"
    );
  },
  permissions,
});

Deno.test({
  name: "Mutual subdirectory error",
  fn: () => {
    const errorMessage =
      "Target and merge folders cannot be children of each other";
    assertRejects(
      () => mergeFolders("fake/dir", "fake/dir/sub"),
      Error,
      errorMessage
    );
    assertRejects(
      () => mergeFolders("fake/dir/sub", "fake/dir"),
      Error,
      errorMessage
    );
    assertRejects(
      () => mergeFolders("fake/dir/sub1/sub2", "fake/dir"),
      Error,
      errorMessage
    );
  },
  permissions,
});

Deno.test({
  name: "Full merge",
  fn: async () => {
    // Create test directories
    const target = await createDir("target");
    const toMerge = await createDir("toMerge");

    try {
      // Merge test directories
      const mergeResults = await mergeFolders(target, toMerge);
      const reportedConflicts = mergeResults.map((c) => c.name);

      const confirmMerge = async (
        testPaths: TestPath[]
      ): Promise<MergeError[]> => {
        const mergeErrors: MergeError[] = [];
        for (const entry of testPaths) {
          const { path } = entry;
          const targetPath = target + SEPARATOR + path;
          // All files should now increase in the target dir
          if (!(await exists(targetPath)))
            mergeErrors.push({ path, error: "MISSING" });
          // If a directory, check all the child paths
          else if (entry.type === "dir")
            mergeErrors.push(...(await confirmMerge(entry.children)));
          else {
            const content = await Deno.readTextFile(targetPath);

            // The expected content of the file is the path
            let expectedContent = entry.path;
            // If it is a conflict and doesn't exist in a target, the conflict is expected to be merged
            if (entry.target === false && entry.conflict)
              expectedContent += conflictPostfix;

            // Make sure the file content is correct
            if (content !== expectedContent)
              mergeErrors.push({ path, error: "OVERWRITTEN" });

            // If there is a conflicted file in the merge and target make sure it's handled correctly
            if (
              entry.conflict &&
              entry.toMerge !== false &&
              entry.target !== false
            ) {
              // Make sure merge conflict file is still present in toMerge
              if (!(await exists(toMerge + SEPARATOR + path)))
                mergeErrors.push({ path, error: "CONFLICT_MISSING" });
              const reportedConflictIndex = reportedConflicts.indexOf(path);
              // The conflict should be present in the merge result
              if (reportedConflictIndex === -1)
                mergeErrors.push({ path, error: "CONFLICT_MISSING" });
              // If it is, remove it so we know it was tracked correctly
              else reportedConflicts.splice(reportedConflictIndex, 1);
            }
          }
        }
        return mergeErrors;
      };

      const mergeErrors = await confirmMerge(testDirectory);
      // Any conflicts still present in the merge result response shouldn't be present
      const badReportedConflicts = reportedConflicts.map(
        (path) =>
          ({
            path,
            error: "BAD_REPORTED_CONFLICT",
          } as const)
      );
      mergeErrors.push(...badReportedConflicts);

      assertEquals(mergeErrors, [], "Should not return any merge errors");
    } finally {
      // Delete test directories
      await Deno.remove(target, { recursive: true });
      await Deno.remove(toMerge, { recursive: true });
    }
  },
  permissions,
});
