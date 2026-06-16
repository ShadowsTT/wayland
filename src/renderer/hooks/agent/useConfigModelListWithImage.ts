import { useMemo } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { curatedImageModelsForProvider, isImageModelName } from '@/common/config/imageModels';

/**
 * Provider list for the image-tool picker, with each provider's image-capable
 * model set resolved and merged into `model[]` (the picker filters image ids
 * back out via {@link isImageModelName}).
 *
 * Image models come from three sources, deduped, best-first:
 *   1. `provider.imageModels` - mirrored from the auto-refreshing model catalog
 *      (newest models.dev image models, no code change needed to stay current).
 *   2. The curated floor for the provider family - guarantees the latest known
 *      ids are present even when the catalog is cold or the registry mirror
 *      skips the provider (e.g. Google-auth Gemini).
 *   3. Any image ids already in the provider's own `model[]` - covers
 *      manually-added providers whose `/v1/models` list includes image ids.
 */
const useConfigModelListWithImage = () => {
  const { data } = useSWR('configModelListWithImage', () => {
    return ipcBridge.mode.getModelConfig.invoke();
  });

  const modelListWithImage = useMemo(() => {
    return (data || []).map((platform) => {
      const fromCatalog = platform.imageModels ?? [];
      const fromCurated = curatedImageModelsForProvider(platform);
      const fromOwnModels = platform.model.filter(isImageModelName);

      const imageModels = Array.from(new Set([...fromCatalog, ...fromCurated, ...fromOwnModels]));
      if (imageModels.length === 0) return platform;

      // Merge image ids into `model` so the existing picker (which filters for
      // image names) surfaces them. Text ids stay first so non-image consumers
      // of this list are unaffected; image-only ids are appended.
      const merged = Array.from(new Set([...platform.model, ...imageModels]));
      return Object.assign({}, platform, { model: merged });
    });
  }, [data]);

  return {
    modelListWithImage,
  };
};

export default useConfigModelListWithImage;
