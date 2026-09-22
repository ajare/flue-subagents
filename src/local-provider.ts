import { setProvider } from '@flue/runtime';

import { DEFAULT_CONFIGURATION } from './config.ts';
import { createModelProvider } from './model-provider.ts';

/** Backwards-compatible default provider registration for the current agents. */
export const localProvider = createModelProvider(DEFAULT_CONFIGURATION);

setProvider(localProvider);
