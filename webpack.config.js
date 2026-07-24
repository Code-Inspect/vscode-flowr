const path = require('path');
const webpack = require('webpack');
const CopyWebpackPlugin = require('copy-webpack-plugin');

// flowR's doc-files.js pulls in a webpack-breaking glob; redirect requires of it to the shim by resolved resource (resolve.alias can't catch relative specifiers)
function flowrDocFilesReplacementPlugin() {
	return new webpack.NormalModuleReplacementPlugin(/(^|\/)doc-files$/, resource => {
		if(resource.context.includes(path.join('@eagleoutice', 'flowr'))) {
			resource.request = path.resolve(__dirname, 'webpack-shims/flowr-doc-files.js');
		}
	});
}

module.exports = () => {
	const nodeExtensionConfig = {
		name: 'node',
		mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
		target: 'node',
		entry: {
			extension: './src/extension.ts',
			// 'test/suite/index': './src/web/test/suite/index.ts' // source of the web extension test runner
		},
		output: {
			filename: 'extension.js',
			path: path.join(__dirname, './dist/node'),
			libraryTarget: 'commonjs',
			devtoolModuleFilenameTemplate: '../../[resource-path]'
		},
		plugins: [
			new CopyWebpackPlugin({
				patterns: [
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' },
					// ship flowR's bundled signature database, otherwise not part of the packaged extension
					{ from: path.resolve(__dirname, 'node_modules/@eagleoutice/flowr/data/sigdb'), to: 'sigdb' }
				]
			}),
			// webpack 5's node-core externalsPreset doesn't recognize `node:`-prefixed requests; strip the prefix first
			new webpack.NormalModuleReplacementPlugin(/^node:/, resource => {
				resource.request = resource.request.replace(/^node:/, '');
			}),
			flowrDocFilesReplacementPlugin()
		],
		externalsPresets: {
			node: true
		},
		externals: [
			{ vscode: 'commonjs vscode' }
		],
		resolve: {
			mainFields: ['module', 'main'],
			extensions: ['.ts', '.js'],
			alias: {
				// provides alternate implementation for node module and source files
			}
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader'
						}
					]
				}
			]
		},
		devtool: 'source-map'
	};

	const webExtensionConfig = {
		name: 'web',
		mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
		target: 'webworker', // extensions run in a webworker context
		entry: {
			extension: './src/extension.ts',
			'test/suite/index': './src/web/test/suite/index.ts'
		},
		output: {
			filename: '[name].js',
			path: path.join(__dirname, './dist/web'),
			libraryTarget: 'commonjs',
			devtoolModuleFilenameTemplate: '../../[resource-path]'
		},
		resolve: {
			mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
			extensions: ['.ts', '.js'], // support ts-files and js-files
			alias: {
				// we don't use these modules on the web (we don't start a local flowr server)
				browser: false,
				child_process: false,
				readline: false,
				net: false,
				'fs/promises': false,
				fs: path.resolve(__dirname, 'webpack-shims/fs.js'),
				clipboardy: false,
				'rotating-file-stream': false,
				timers: false,
				https: false,
				http: false,
				crypto: path.resolve(__dirname, 'webpack-shims/crypto.js'),
				'stream/promises': false,
				// `v8` has no web equivalent; provide a shim so heap-pressure checks are no-ops
				v8: path.resolve(__dirname, 'webpack-shims/v8.js')
			},
			fallback: {
				// Webpack 5 no longer polyfills Node.js core modules automatically, see https://webpack.js.org/configuration/resolve/#resolvefallback
				assert: require.resolve('assert'),
				path: require.resolve('path-browserify'),
				stream: require.resolve('stream-browserify'),
				util: require.resolve('util'),
				os: require.resolve('os-browserify/browser'),
				url: require.resolve('url'),
				zlib: path.resolve(__dirname, 'webpack-shims/zlib.js'),
				constants: require.resolve('constants-browserify'),
				buffer: require.resolve('buffer')
			}
		},
		module: {
			rules: [
				{
					test: /\.ts$/,
					exclude: /node_modules/,
					use: [
						{
							loader: 'ts-loader'
						}
					]
				}
			]
		},
		plugins: [
			new webpack.ProvidePlugin({
				Buffer: ['buffer', 'Buffer'],
				process: 'process/browser' // provide a shim for the global `process` variable
			}),
			new CopyWebpackPlugin({
				patterns: [
					{ from: path.resolve(__dirname, 'resources'), to: 'resources' },
					// ship flowR's bundled signature database (see the node config for details)
					{ from: path.resolve(__dirname, 'node_modules/@eagleoutice/flowr/data/sigdb'), to: 'sigdb' },
					{ from: path.resolve(__dirname, 'node_modules/brotli-dec-wasm/pkg/brotli_dec_wasm_bg.wasm'), to: 'wasm/brotli_dec_wasm_bg.wasm' }
				]
			}),
			// see the node config for why (`node:` prefix handling); resolve.alias below stubs the bare names out to false
			new webpack.NormalModuleReplacementPlugin(/^node:/, resource => {
				resource.request = resource.request.replace(/^node:/, '');
			}),
			flowrDocFilesReplacementPlugin()
		],
		externals: [
			{ vscode: 'commonjs vscode' }
		],
		performance: {
			hints: false
		},
		devtool: 'nosources-source-map' // create a source map that points to the original source file
	};

	return [nodeExtensionConfig, webExtensionConfig];
};
