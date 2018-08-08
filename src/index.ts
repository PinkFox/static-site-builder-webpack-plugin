import { load as cheerioLoad } from 'cheerio';
import { join } from 'path';
import { createContext, Script } from 'vm';
import { compilation, Compiler, Plugin, Stats } from 'webpack';
import { CachedSource, RawSource } from 'webpack-sources';

const url = require('url');

type StaticSiteBuilderWebpackPluginObject<Type> = {
	[key: string]: Type;
}

type StaticSiteBuilderWebpackPluginRenderer = (locals: StaticSiteBuilderWebpackPluginObject<any>) => string;

interface StaticSiteBuilderWebpackPluginOptions {
	crawl?: boolean;
	entry?: string;
	globals?: StaticSiteBuilderWebpackPluginObject<any>;
	locals?: StaticSiteBuilderWebpackPluginObject<any>;
	paths?: string[];
};

/**
 * Static Site Builder Webpack Plugin
 */
class StaticSiteBuilderWebpackPlugin implements Plugin {

	private readonly tapName: string = 'StaticSiteBuilder';

	private crawl: boolean;
	private entry?: string;
	private globals?: StaticSiteBuilderWebpackPluginObject<any>;
	private locals?: StaticSiteBuilderWebpackPluginObject<any>;
	private paths: string[];

	constructor(options?: StaticSiteBuilderWebpackPluginOptions) {

		options = options || {};

		this.crawl = !!options.crawl;
		this.entry = options.entry;
		this.globals = options.globals;
		this.locals = options.locals;
		this.paths = Array.isArray(options.paths) ? options.paths : [options.paths || '/'];

	}

	/**
	 * Apply method called when Webpack is installing the plugin
	 * @param compiler Compiler from Webpack
	 */
	public apply(compiler: Compiler): void {
		compiler.hooks.thisCompilation.tap(this.tapName, (compilation) => {
			compilation.hooks.optimizeAssets.tap(this.tapName, (otherassets: any) => {

				const webpackStats = compilation.getStats();
				const webpackStatsJson = webpackStats.toJson();

				try {

					const asset = this.findAsset(this.entry, compilation, webpackStatsJson);

					if (!asset) {
						throw new Error(`Source file not found: "${this.entry}"`);
					}

					const assets = this.getAssetsFromCompilation(compilation, webpackStatsJson);
					const source = asset.source();
					let renderer = this.getRenderer(source);

					this.renderPaths(this.paths, renderer, assets, webpackStats, compilation);

				} catch (e) {
					compilation.errors.push(e.stack);
				}

			});
		});
	}

	/**
	 * Searches for the appropriate asset in the compilation or the stats if that fails
	 * @param src The entry name provided in the options
	 * @param compilation Current Webpack compilation
	 * @param webpackStatsJson Webpack Stats for the current compilation
	 */
	private findAsset(src: any, compilation: compilation.Compilation, webpackStatsJson: any): CachedSource | null {

		// Retrieve the main chunk name if an entry name wasn't provided in the options
		if (!src) {
			const chunkNames = Object.keys(webpackStatsJson.assetsByChunkName);
			src = chunkNames[0];
		}

		const asset = compilation.assets[src];

		// Asset was found in the compilation
		if (asset) {
			return asset;
		}

		// Asset wasn't found in the compilation, attempt to find in stats
		let chunkValue = webpackStatsJson.assetsByChunkName[src];

		// Abort if the asset wasn't found in the stats
		if (!chunkValue) {
			return null;
		}

		// Get the main chunk name if the the chunk is an array
		if (Array.isArray(chunkValue)) {
			chunkValue = chunkValue[0];
		}

		return compilation.assets[chunkValue];

	}

	/**
	 * Loops through the chunks in stats and returns an object mapping the 
	 * name of the chunk to its output filename
	 * 
	 * Shamelessly stolen from html-webpack-plugin - Thanks @ampedandwired :)
	 * @param compilation Current Webpack compilation
	 * @param webpackStatsJson Webpack Stats for the current compilation
	 */
	private getAssetsFromCompilation(compilation: compilation.Compilation, webpackStatsJson: any): StaticSiteBuilderWebpackPluginObject<any> {

		let assets: StaticSiteBuilderWebpackPluginObject<any> = {};

		// Loops through each asset chunk and maps their names to their emitted filenames
		for (const chunkName in webpackStatsJson.assetsByChunkName) {
			let chunkValue = webpackStatsJson.assetsByChunkName[chunkName];

			// Get the main chunk filename if the chunk is an array
			if (Array.isArray(chunkValue)) {
				chunkValue = chunkValue[0];
			}

			// Prepend the publicPath if one was provided to Webpack
			if (compilation.outputOptions.publicPath) {
				chunkValue = compilation.outputOptions.publicPath + chunkValue;
			}

			// Add asset
			assets[chunkName] = chunkValue;

		}

		return assets;

	}

	/**
	 * Evalutes the source in a sandbox and returns the exported module 
	 * as long as it is a function
	 * 
	 * Modified version of node-eval by @pierrec
	 * @param source Module source string
	 */
	private getRenderer(source: string): StaticSiteBuilderWebpackPluginRenderer {

		const parentFilename = (module.parent ? module.parent.filename : '');
		const filename = this.entry || parentFilename;
		let sandbox: StaticSiteBuilderWebpackPluginObject<any> = {};

		// Merge in the Node globals
		Object.assign(sandbox, global);

		sandbox.require = require(filename);

		// Merge in the plugin globals
		Object.assign(sandbox, this.globals);

		// Setup sandbox for a Node environment
		sandbox.exports = exports;
		sandbox.module = {
			exports: exports,
			filename: filename,
			id: filename,
			parent: parentFilename,
			require: sandbox.require || require(filename)
		};
		sandbox.global = sandbox;

		const options = {
			filename: filename,
			displayErrors: false
		};

		/**
		 * TODO: Add reasoning for this filtering from when known:
		 * @see https://github.com/pierrec/node-eval/commit/9b6389920aaf90b3250701d77a4f2739dfba7e91
		 */
		const stringScript = source.replace(/^\#\!.*/, '');
		const context = createContext(sandbox);
		const script = new Script(stringScript);
		script.runInContext(context, options);

		const renderer = (sandbox.module.exports.default ? sandbox.module.exports.default : sandbox.module.exports);

		if (typeof renderer !== 'function') {
			throw new Error(`Export from "${this.entry}" must be a function that returns an HTML string. Is output.libraryTarget in the configuration set to "umd"?`);
		}

		// Return default export if available, otherwise just return the export
		return (sandbox.module.exports.default ? sandbox.module.exports.default : sandbox.module.exports);

	}

	private renderPaths(
		paths: string[],
		renderer: StaticSiteBuilderWebpackPluginRenderer, 
		assets: StaticSiteBuilderWebpackPluginObject<any>, 
		webpackStats: Stats, 
		compilation: compilation.Compilation
	): Promise<any> {

		const renderPromises = paths.map((outputPath) => {

			let locals: StaticSiteBuilderWebpackPluginObject<any> = {
				path: outputPath,
				assets: assets,
				webpackStats: webpackStats
			};

			if (this.locals) {
				for (const prop in this.locals) {
					if (this.locals[prop]) {
						locals[prop] = this.locals[prop];
					}
				}
			}

			return Promise.resolve(renderer(locals))
				.then((output) => {

					// Ensure output is an object for mapping by key below
					const outputByPath = typeof output === 'object' ? output : { [outputPath]: output };

					const assetGenerationPromises = Object.keys(outputByPath).map((key) => {
						const rawSource = outputByPath[key];
						const assetName = this.pathToAssetName(outputPath);

						// Avoid overwriting an existing asset
						if (compilation.assets[assetName]) {
							return;
						}

						compilation.assets[assetName] = new RawSource(rawSource);

						if (this.crawl) {
							const relativePaths = this.relativePathsFromHtml(rawSource, key);
							return this.renderPaths(relativePaths, renderer, assets, webpackStats, compilation);
						}

					});

					return Promise.all(assetGenerationPromises);

				});

		});

		return Promise.all(renderPromises);

	}

	/**
	 * Returns the filename based on the output path provided
	 * @param outputPath Output path string
	 */
	private pathToAssetName(outputPath: string): string {

		// Remove leading slashes for webpack-dev-server
		let outputFilename = outputPath.replace(/^(\/|\\)/, '');

		// Check if path provided to plugin, if not add index.html to the outputFilename path
		if (!/\.html?$/i.test(outputFilename)) {
			outputFilename = join(outputFilename, 'index.html');
		}

		return outputFilename;

	}

	/**
	 * Returns the paths in the HTML source for use in crawling
	 * @param options 
	 */
	private relativePathsFromHtml(source: string, basePath: string): string[] {
		
		// Creates a virtual DOM using cheerio
		const $ = cheerioLoad(source);

		// Fetches paths from <a> tags
		const linkHrefs = $('a[href]')
			.map((index, element) => {
				return $(element).attr('href');
			})
			.get();

		// Fetches paths from <iframe> tags
		const iframeSrcs = $('iframe[src]')
			.map((index, element) => {
				return $(element).attr('src');
			})
			.get();

		// Spread paths into a new array and map them to string or null based on the path
		const paths = [...linkHrefs, ...iframeSrcs]
			.map((href) => {

				if (href.indexOf('//') === 0) {
					return null;
				}

				let parsed = url.parse(href);

				if (parsed.protocol || typeof parsed.path !== 'string') {
					return null;
				}

				if (parsed.path.indexOf('/') === 0) {
					return parsed.path;
				} else {
					return url.resolve(basePath, parsed.path);
				}

			});

		// Filters out the nulls from the mapped paths
		// TODO: Find out if there is a way to avoid casting here
		const filteredPaths = paths
			.filter((href) => {
				return typeof href === 'string';
			}) as string[];

		return filteredPaths;

	}

}

export default StaticSiteBuilderWebpackPlugin;
