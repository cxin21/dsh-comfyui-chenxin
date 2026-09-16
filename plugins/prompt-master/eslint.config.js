import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '**/*.pyc'] },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ['src/**/*.ts', 'tests/**/*.ts'],
  })),
  {
    rules: {
      // 渐进收口（2026-09-17 审计 F9）：resolver 移植层 any 全面类型化另立计划；
      // 本轮只禁新增的显式 any 表达式（@typescript-eslint/no-explicit-any 默认 warn——升 error 交由后续收紧）
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', destructuredArrayIgnorePattern: '^_' },
      ],
      'no-console': 'off', // 降级留痕语义（资源层无 ctx.logger，见 anima-vector.ts 头注释）
    },
  },
);
