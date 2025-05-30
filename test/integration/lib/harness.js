
import path from 'path';
import fs from 'fs';
import {globSync} from 'glob';
import shuffleSeed from 'shuffle-seed';
import {queue} from 'd3-queue';
import chalk from 'chalk';
import template from 'lodash/template.js';
import createServer from './server.js';
// eslint-disable-next-line import/order
import {fileURLToPath} from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

import {createRequire} from 'module';
const require = createRequire(import.meta.url);

export default function (directory, implementation, options, run) {
    const q = queue(1);
    const server = createServer();

    const tests = options.tests || [];
    const ignores = options.ignores || {'todo': [], 'skip': []};

    let sequence = globSync(`**/${options.fixtureFilename || 'style.json'}`, {cwd: directory})
        .sort((a, b) => a.localeCompare(b, 'en'))
        .map(fixture => {
            const id = path.dirname(fixture);
            const style = require(path.join(directory, fixture));

            server.localizeURLs(style);

            style.metadata = style.metadata || {};
            const testName = `${path.basename(directory)}/${id}`;
            style.metadata.test = Object.assign({
                id,
                skip: ignores.skip.includes(testName) || ignores.todo.includes(testName),
                width: 512,
                height: 512,
                pixelRatio: 1,
                allowed: 0.00015
            }, style.metadata.test);

            return style;
        })
        .filter(style => {
            const test = style.metadata.test;

            if (tests.length !== 0 && !tests.some(t => test.id.indexOf(t) !== -1)) {
                return false;
            }

            if (implementation === 'native' && process.env.BUILDTYPE !== 'Debug' && test.id.match(/^debug\//)) {
                console.log(chalk.gray(`* skipped ${test.id}`));
                return false;
            }

            if (test.skip) {
                console.log(chalk.gray(`* skipped ${test.id}`));
                return false;
            }

            return true;
        });

    if (options.shuffle) {
        console.log(chalk.white(`* shuffle seed: `) + chalk.bold(`${options.seed}`));
        sequence = shuffleSeed.shuffle(sequence, options.seed);
    }

    q.defer(server.listen);

    sequence.forEach(style => {
        q.defer((callback) => {
            const test = style.metadata.test;

            try {
                run(style, test, handleResult);
            } catch (error) {
                handleResult(error);
            }

            function handleResult(error) {
                if (error) {
                    test.error = error;
                }

                if (test.ignored && !test.ok) {
                    test.color = '#9E9E9E';
                    test.status = 'ignored failed';
                    console.log(chalk.white(`* ignore ${test.id} (${test.ignored})`));
                } else if (test.ignored) {
                    test.color = '#E8A408';
                    test.status = 'ignored passed';
                    console.log(chalk.yellow(`* ignore ${test.id} (${test.ignored})`));
                } else if (test.error) {
                    test.color = 'red';
                    test.status = 'errored';
                    console.log(chalk.red(`* errored ${test.id}`));
                } else if (!test.ok) {
                    test.color = 'red';
                    test.status = 'failed';
                    console.log(chalk.red(`* failed ${test.id}`));
                } else {
                    test.color = 'green';
                    test.status = 'passed';
                    console.log(chalk.green(`* passed ${test.id}`));
                }

                callback(null, test);
            }
        });
    });

    q.defer(server.close);

    q.awaitAll((err, results) => {
        if (err) {
            console.error(err);
            setTimeout(() => { process.exit(-1); }, 0);
            return;
        }

        const tests = results.slice(1, -1);

        if (process.env.UPDATE) {
            console.log(`Updated ${tests.length} tests.`);
            process.exit(0);
        }

        let passedCount = 0,
            ignoreCount = 0,
            ignorePassCount = 0,
            failedCount = 0,
            erroredCount = 0;

        tests.forEach((test) => {
            if (test.ignored && !test.ok) {
                ignoreCount++;
            } else if (test.ignored) {
                ignorePassCount++;
            } else if (test.error) {
                erroredCount++;
            } else if (!test.ok) {
                failedCount++;
            } else {
                passedCount++;
            }
        });

        const totalCount = passedCount + ignorePassCount + ignoreCount + failedCount + erroredCount;

        if (passedCount > 0) {
            console.log(chalk.green('%d passed (%s%)'),
                passedCount, (100 * passedCount / totalCount).toFixed(1));
        }

        if (ignorePassCount > 0) {
            console.log(chalk.yellow('%d passed but were ignored (%s%)'),
                ignorePassCount, (100 * ignorePassCount / totalCount).toFixed(1));
        }

        if (ignoreCount > 0) {
            console.log(chalk.white('%d ignored (%s%)'),
                ignoreCount, (100 * ignoreCount / totalCount).toFixed(1));
        }

        if (failedCount > 0) {
            console.log(chalk.red('%d failed (%s%)'),
                failedCount, (100 * failedCount / totalCount).toFixed(1));
        }

        if (erroredCount > 0) {
            console.log(chalk.red('%d errored (%s%)'),
                erroredCount, (100 * erroredCount / totalCount).toFixed(1));
        }

        const resultsTemplate = template(fs.readFileSync(path.join(__dirname, '..', 'results.html.tmpl'), 'utf8'));
        const itemTemplate = template(fs.readFileSync(path.join(directory, 'result_item.html.tmpl'), 'utf8'));

        const stats = {};
        for (const test of tests) {
            stats[test.status] = (stats[test.status] || 0) + 1;
        }

        const unsuccessful = tests.filter(test => test.status === 'failed' || test.status === 'errored');

        const resultsShell = resultsTemplate({unsuccessful, tests, stats, shuffle: options.shuffle, seed: options.seed})
            .split('<!-- results go here -->');

        const p = path.join(directory, 'index.html');
        const out = fs.createWriteStream(p);

        const q = queue(1);
        q.defer(write, out, resultsShell[0]);
        for (const test of tests) {
            const escaped = itemTemplate({r: test, hasFailedTests: unsuccessful.length > 0});
            // Undo lodash.template's escape characters to correctly render "<" and ">" as html.
            const fixed = escaped.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
            q.defer(write, out, fixed);
        }
        q.defer(write, out, resultsShell[1]);
        q.await(() => {
            out.end();
            out.on('close', () => {
                console.log(`Results at: ${p}`);
                process.exit((failedCount + erroredCount) === 0 ? 0 : 1);
            });
        });
    });
}

function write(stream, data, cb) {
    if (!stream.write(data)) {
        stream.once('drain', cb);
    } else {
        process.nextTick(cb);
    }
}
