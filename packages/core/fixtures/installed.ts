/** The shape of each project fixture's `installed.json`, written by `scripts/generate-fixtures.ts`. */
export type InstalledProject = {
  /** The Bun version that installed the project and wrote its `bun.lock`. */
  bun: string;
  lockfileVersion: number;
  /** Where the install ran; optional packages for other platforms are not installed. */
  platform: string;
  /**
   * Per workspace directory (`''` for the root), its registry dependencies by declared name:
   * the installed `name@version`, the declaring field and its scope, and the specifier.
   */
  workspaces: Record<
    string,
    Record<
      string,
      {
        id: string;
        field: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
        scope: 'runtime' | 'development';
        specifier: string;
      }
    >
  >;
  /** Every registry package reachable from a workspace, by `name@version`. */
  packages: Record<
    string,
    { direct?: true; scope: 'runtime' | 'development'; dependencies: string[] }
  >;
  /** Names of optional dependencies that were not installed, such as other platforms' binaries. */
  skippedOptional: string[];
};
