import {createWorkspace} from '@sewing-kit/config';
// import {quiltWorkspace} from '@quilted/sewing-kit-plugins';
import {cloudflareWorkers} from './packages/plugin-cloudflare-workers';

console.log('he')

export default createWorkspace((workspace) => {
  workspace.use(cloudflareWorkers());
});
