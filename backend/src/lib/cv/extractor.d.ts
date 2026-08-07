// Types for the legacy JavaScript extractor, so TypeScript tooling can call it
// without `allowJs` and without modifying the legacy module itself.
//
// Declaration only — it adds no behaviour and changes no output. It exists
// because the benchmark harness must measure the CURRENT parser to establish a
// baseline, and measuring it requires calling it.

export declare function extractText(filePath: string): Promise<string> | string;
export declare function extractTextAsync(filePath: string): Promise<string>;
export declare function isSupported(filePath: string): boolean;
export declare const SUPPORTED_EXTENSIONS: string[];
