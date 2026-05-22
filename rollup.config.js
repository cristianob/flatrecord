import babel from '@rollup/plugin-babel';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const plugins = [
    resolve({
        resolveOnly: ['flatbuffers', 'slice-source', '@repeaterjs/repeater'],
    }),
    babel({
        exclude: 'node_modules/**',
        presets: [
            [
                '@babel/env',
                {
                    modules: false,
                    targets: {
                        browsers: ['>2%', 'not dead', 'not ie 11'],
                    },
                },
            ],
        ],
        babelrc: false,
        babelHelpers: 'bundled',
    }),
    terser(),
];

export default [
    {
        input: './lib/mjs/index.js',
        output: [
            {
                file: 'dist/flatrecord.min.js',
                format: 'umd',
                name: 'flatrecord',
                sourcemap: false,
            },
            {
                file: 'dist/flatrecord.esm.min.js',
                format: 'esm',
                sourcemap: false,
            },
        ],
        plugins,
    },
    {
        input: './lib/mjs/geojson.js',
        output: [
            {
                file: 'dist/flatrecord-geojson.min.js',
                format: 'umd',
                name: 'flatrecord',
                sourcemap: false,
            },
            {
                file: 'dist/flatrecord-geojson.esm.min.js',
                format: 'esm',
                sourcemap: false,
            },
        ],
        plugins,
    },
];
