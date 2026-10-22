import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

// Only the modules the first src block ignores write styles, attributes or the element tree;
// refresh()'s values go through commit.ts.
const domWrites = [
  'AssignmentExpression[left.object.property.name="style"]',
  'VariableDeclarator[init.property.name="style"]',
  'ObjectPattern > Property[key.name="style"]',
  'CallExpression[callee.property.name=/^(setProperty|removeProperty|setAttribute|removeAttribute|toggleAttribute)$/]',
  'CallExpression[callee.property.name=/^(appendChild|insertBefore|removeChild|replaceChild|append|prepend|before|after|replaceWith|remove)$/]',
].map((selector) => ({
  selector,
  message: 'Write to the DOM through commit.ts, dom.ts or structure.ts.',
}));
// Only gsap.ts reads or writes GSAP's runtime state. no-restricted-syntax is one rule, and a later
// block's list replaces an earlier one's for a file, so each block lists everything it forbids.
const gsapAccess = [
  'MemberExpression[property.name=/^(isRefreshing|isScrolling|isUpdating|getScrollFunc|rec)$/]',
  'CallExpression[callee.property.name=/^(add|remove)EventListener$/][arguments.0.value=/^refresh(Init)?$/]',
].map((selector) => ({
  selector,
  message: 'Read or write GSAP through gsap.ts.',
}));

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'coverage/**',
      '.cache/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  stylistic.configs.recommended,
  {
    rules: {
      // Differences from recommended (overrides to match the existing code's style)
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'semi', requireLast: true },
          singleline: { delimiter: 'semi' },
        },
      ],

      // Rules added that aren't in recommended
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['const', 'let', 'var'] },
        { blankLine: 'never', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
        { blankLine: 'always', prev: 'directive', next: '*' },
        { blankLine: 'any', prev: 'directive', next: 'directive' },
        { blankLine: 'always', prev: '*', next: ['if', 'for', 'while', 'switch', 'try'] },
        { blankLine: 'always', prev: ['if', 'for', 'while', 'switch', 'try'], next: '*' },
        { blankLine: 'always', prev: '*', next: 'multiline-block-like' },
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'function' },
        { blankLine: 'always', prev: 'function', next: '*' },
        { blankLine: 'always', prev: '*', next: 'class' },
        { blankLine: 'always', prev: 'class', next: '*' },
      ],
      '@stylistic/padded-blocks': ['error', 'never'],
      '@stylistic/max-len': [
        'error',
        {
          code: 100,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/**/*.test.ts',
      'src/commit.ts',
      'src/dom.ts',
      'src/structure.ts',
      'src/dormancy.ts',
      'src/scrollMargin.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...domWrites, ...gsapAccess],
    },
  },
  {
    files: [
      'src/commit.ts',
      'src/dom.ts',
      'src/structure.ts',
      'src/dormancy.ts',
      'src/scrollMargin.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...gsapAccess],
    },
  },
  {
    files: ['src/gsap.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...domWrites],
    },
  },
  {
    files: ['**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
