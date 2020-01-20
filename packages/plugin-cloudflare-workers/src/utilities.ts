import {
  Package,
  createComposedProjectPlugin,
  createProjectTestPlugin,
} from '@sewing-kit/plugins';
import {babelConfigurationHooks} from '@sewing-kit/plugin-babel';
import {jestConfigurationHooks} from '@sewing-kit/plugin-jest';
import {javascript} from '@sewing-kit/plugin-javascript';
import {typescript} from '@sewing-kit/plugin-typescript';

import {buildFlexibleOutputs} from '@sewing-kit/plugin-package-flexible-outputs';

const jestRemoveBabelPresetModuleMapperPlugin = createRemoveSourceMappingPlugin();

export const createSewingKitPackagePlugin = ({typesAtRoot = false} = {}) =>
  createComposedProjectPlugin<Package>('SewingKit.InternalPackage', [
    babelConfigurationHooks,
    jestConfigurationHooks,
    jestRemoveBabelPresetModuleMapperPlugin,
    javascript(),
    typescript(),
    buildFlexibleOutputs({
      node: false,
      esmodules: false,
      esnext: false,
      commonjs: true,
      binaries: true,
      typescript: {typesAtRoot},
    }),
  ] as const);

