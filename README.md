# @md/merge-folders

Exports a function `mergeFolders` which allows you to specify to folders which should be merged into one.

The function will move each file for `toMerge` into `target` where no equivalent file exists. If both have the same file, it will compute a SHA-256 hash for each file's content to check if they're the same. If not, it will keep the file in `toMerge` for manual resolution.

Finally, it will clean up the `toMerge` directory removing any empty subdirectories including itself if no files has conflicts.