// The first-party packs the CLI loads (design §17). Third-party packs will be
// loaded explicitly from the config; there is no auto-discovery.

import type { DomainPack, LanguagePack } from '@yokla/core';
import { ecommercePack } from '@yokla/pack-ecommerce';
import { english } from '@yokla/pack-lang-en';
import { turkish } from '@yokla/pack-lang-tr';

export const DOMAIN_PACKS: readonly DomainPack[] = [ecommercePack];
export const LANGUAGE_PACKS: readonly LanguagePack[] = [turkish, english];
