/* eslint-disable no-console */
import {createWorkspaceLintPlugin} from '@sewing-kit/plugins';

const PLUGIN = 'SewingKit.CloudflareWorkers';

export function cloudflareWorkers() {
  return createWorkspaceLintPlugin(PLUGIN, (args) => {
    console.log('runnning sewing kit cloudflare plugin')
    console.log(PLUGIN, args);
  });
}
