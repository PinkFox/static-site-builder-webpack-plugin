import cleanup from 'rollup-plugin-cleanup';
import clear from 'rollup-plugin-clear';
import typescript from 'rollup-plugin-typescript2';

export default {
    external: [
        'cheerio', // Dependency
        'path', // Node
        'vm', // Node
        'webpack', // Peer Dependency
        'webpack-sources' // Peer Dependency
    ],
    input: './src/index.ts',
    output: {
        file: './lib/index.js',
        format: 'cjs'
    },
    plugins: [
        clear({
            targets: ['./lib/'],
            watch: true
        }),
        typescript({
            typescript: require('typescript')
        }),
        cleanup({
            extensions: ['.js', '.ts']
        })
    ]
};