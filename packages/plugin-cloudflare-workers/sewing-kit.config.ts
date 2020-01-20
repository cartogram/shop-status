import {createPackage, Runtime} from '@sewing-kit/config';
import {
  Package,
  createComposedProjectPlugin,
  createProjectTestPlugin,
} from '@sewing-kit/plugins';

export default createPackage((pkg) => {
  pkg.runtime(Runtime.Node);
  pkg.use(createSewingKitPackagePlugin());
});

export const createSewingKitPackagePlugin = ({typesAtRoot = false} = {}) =>
  createComposedProjectPlugin<Package>(
    'SewingKit.CloudflareWorkers',
    [] as const,
  );
