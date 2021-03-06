import {createServer} from 'http';

import {createWebApp} from '@sewing-kit/config';
import {
  WebApp,
  createProjectDevPlugin,
  createProjectBuildPlugin,
  createComposedProjectPlugin,
} from '@sewing-kit/plugins';
import {quiltWebApp} from '@quilted/sewing-kit-plugins';

import {webpackPlugins} from '@sewing-kit/plugin-webpack';
import {addBabelPlugin} from '@sewing-kit/plugin-babel';

export default createWebApp((app) => {
  app.entry('./index');
  app.use(
    quiltWebApp(),
    createProjectBuildPlugin('Watch.App.BuildHtml', ({api, hooks, project}) => {
      hooks.steps.hook((steps, {webpackBuildManager}) => {
        return [
          api.createStep(
            {label: 'build static html output', id: 'StaticHtml.Build'},
            (step) => {
              return new Promise((resolve) => {
                webpackBuildManager?.on(project, (stats) => {
                  step.log(`has errors: ${stats.hasErrors()}`);
                  resolve();
                });
              });
            },
          ),
          ...steps,
        ];
      });
    }),
    createProjectDevPlugin('Watch.App.Dev', ({api, hooks, project}) => {
      hooks.steps.hook((steps, {webpackBuildManager}) => [
        ...steps,
        api.createStep(
          {
            label: 'starting stating HTML development server',
            id: 'StaticHtml.DevServer',
          },
          async (step) => {
            const currentAssets = new Set<string>();

            webpackBuildManager?.on(
              project,
              (stats: import('webpack').Stats) => {
                const {publicPath, assets = []} = stats.toJson({
                  assets: true,
                  publicPath: true,
                });

                currentAssets.clear();

                for (const asset of assets) {
                  if (publicPath == null) {
                    currentAssets.add(asset.name);
                  } else {
                    currentAssets.add(
                      publicPath.endsWith('/')
                        ? `${publicPath}${asset.name}`
                        : `${publicPath}/${asset.name}`,
                    );
                  }
                }
              },
            );

            step.indefinite(({stdio}) => {
              createServer((req, res) => {
                stdio.stdout.write(`request for path: ${req.url}\n`);

                res.writeHead(200, {
                  'Content-Type': 'text/html',
                  // 'Content-Security-Policy':
                  //   "default-src http://* https://* 'unsafe-eval'",
                });
                res.write(
                  `<html>
                    <head></head>
                    <body>
                      <div id="app"></div>
                      ${[...currentAssets]
                        .map(
                          (asset) =>
                            `<script src=${JSON.stringify(asset)}></script>`,
                        )
                        .join('\n')}
                    </body>
                  </html>`,
                );
                res.end();
              }).listen(8082);
            });
          },
        ),
      ]);
    }),
    // reactRefresh(),
  );
});

// function reactRefresh() {
//   return createComposedProjectPlugin<WebApp>('ReactRefresh', [
//     webpackPlugins(async () => {
//       const {default: ReactRefreshWebpackPlugin} = await import(
//         'react-refresh-webpack-plugin'
//       );

//       return new ReactRefreshWebpackPlugin({disableRefreshCheck: true});
//     }),
//     addBabelPlugin('react-refresh/babel'),
//   ]);
// }
