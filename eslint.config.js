export default [
    {
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'prefer-const': 'warn',
            'no-console': 'off',
        },
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                setTimeout: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                Math: 'readonly',
                Date: 'readonly',
                Promise: 'readonly',
                Set: 'readonly',
                Map: 'readonly',
                Array: 'readonly',
                Object: 'readonly',
                String: 'readonly',
                Number: 'readonly',
            },
        },
    },
];
