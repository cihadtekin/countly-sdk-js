
import resolve from "@rollup/plugin-node-resolve";
import babel from "@rollup/plugin-babel";

export default [
    {
        input: "./Countly.js",
        output: [
            {
                file: "dist/countly_esm.js",
                format: "esm",
                name: "Countly",
                sourcemap: true,
                exports: "named",
                extend: true,
                globals: { crypto: "crypto", Countly: "Countly" },
            },
            {
                file: "dist/countly_umd.js",
                format: "umd",
                name: "Countly",
                sourcemap: true,
                exports: "default",
                globals: { crypto: "crypto", Countly: "Countly" },
            },
            {
                file: "dist/countly_cjs.js",
                format: "cjs",
                name: "Countly",
                sourcemap: true,
                exports: "default",
                globals: { crypto: "crypto", Countly: "Countly" },
            },
        ],
        plugins: [
            resolve({
                preferBuiltins: true,
            }),
            babel({
                babelrc: false,
                presets: ["@babel/preset-env"],
                babelHelpers: "bundled",
                // plugins : ["istanbul"] // use for code coverage
            }),
        ],
    },
    // Session Replay recording module (lib/countly_recording.js in countly-sdk-web): a separate
    // script loaded after the SDK, which attaches to window.Countly
    {
        input: "./modules/recording/index.js",
        output: [
            {
                file: "dist/countly_recording.js",
                format: "iife",
                name: "CountlyRecording",
                sourcemap: true,
                exports: "named",
            },
        ],
        plugins: [
            resolve({
                preferBuiltins: true,
            }),
            babel({
                babelrc: false,
                presets: ["@babel/preset-env"],
                babelHelpers: "bundled",
            }),
        ],
    }

];