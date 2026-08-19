/**
 * Module boundary enforcement.
 *
 * The structure in src/modules/ is only real if crossing a boundary fails the
 * build. Before this file existed there were 58 deep imports into `database`
 * and 33 into `persistence` — not because anyone was careless, but because
 * nothing stopped them.
 *
 *   npm run boundaries        # report
 *   npm run boundaries:graph  # visual graph (needs graphviz)
 */
module.exports = {
  forbidden: [
    {
      name: 'no-deep-module-imports',
      severity: 'error',
      comment:
        'Import a module through its index.ts, never one of its internal files. ' +
        'If you need something that is not exported, export it deliberately — ' +
        'that is the decision this rule is asking you to make consciously.',
      from: { path: '^src/modules/([^/]+)/' },
      to: {
        path: '^src/modules/([^/]+)/(?!index\\.ts$).+',
        pathNot: [
          // Inside your own module, import whatever you like.
          '^src/modules/$1/',
        ],
      },
    },
    {
      name: 'kernel-must-not-know-features',
      severity: 'error',
      comment:
        'kernel/ is infrastructure and sits below every feature. A kernel file ' +
        'importing a module inverts that and makes the kernel un-reusable.',
      from: { path: '^src/kernel/' },
      to: { path: '^src/modules/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'A cycle between modules means the boundary is fictional — neither side ' +
        'can be understood, tested, or moved without the other.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable file — dead code, or a missing wire-up.',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)tsconfig\\.json$',
          '\\.module\\.ts$',
          '(^|/)main\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'no-test-imports-in-src',
      severity: 'error',
      comment: 'Production code must never import from tests/.',
      from: { path: '^src/' },
      to: { path: '^tests/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.ts'],
    },
    reporterOptions: {
      dot: { collapsePattern: '^src/(kernel|modules)/[^/]+' },
      archi: { collapsePattern: '^src/(kernel|modules)/[^/]+' },
    },
  },
};
