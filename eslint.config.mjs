// Flat config, at the repository root and nowhere else. ESLint 9 dropped the
// cascade that made per-package `.eslintrc` files work, so one file that knows
// about every package is now the supported shape rather than a preference.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      // Layout data for the diagram generator, formatted by hand — see
      // .prettierignore, which excludes it for the same reason.
      'docs/diagrams/_generator/**',
    ],
  },

  eslint.configs.recommended,

  // Type-checked rules, not just syntactic ones. The rules worth having here
  // — no floating promises, no unsafe `any` flowing into a call — cannot be
  // decided without the type-checker, and this is a codebase where an
  // unawaited promise in a Kafka consumer is a real class of bug.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Resolves each file to the tsconfig that owns it, so a new package
        // needs no entry here.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Config files and scripts are plain JavaScript with no tsconfig to belong
  // to; type-aware rules cannot run on them.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
