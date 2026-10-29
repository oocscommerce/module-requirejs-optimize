<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Filesystem\Driver\File;
use Magento\Framework\View\Design\Theme\ThemeProviderInterface;
use Magento\Framework\View\Design\ThemeInterface;
use Magento\Framework\View\DesignInterface;
use Magento\Store\Api\Data\StoreInterface;
use Magento\Store\Model\ScopeInterface;
use Magento\Store\Model\StoreManagerInterface;

/**
 * Theme/locale pairs used by active store views.
 */
class TargetList
{
    private const AREA = 'frontend';

    /**
     * Inject dependencies.
     *
     * @param StoreManagerInterface $storeManager
     * @param ScopeConfigInterface $scopeConfig
     * @param DesignInterface $design
     * @param ThemeProviderInterface $themeProvider
     * @param DirectoryList $directoryList
     * @param File $file
     */
    public function __construct(
        private readonly StoreManagerInterface $storeManager,
        private readonly ScopeConfigInterface $scopeConfig,
        private readonly DesignInterface $design,
        private readonly ThemeProviderInterface $themeProvider,
        private readonly DirectoryList $directoryList,
        private readonly File $file
    ) {
    }

    /**
     * Targets: theme, locale, storeIds, deployed, requireJs.
     *
     * @param string|null $themeFilter Vendor/theme
     * @param string|null $localeFilter xx_XX
     * @return array<int, array>
     */
    public function get(?string $themeFilter = null, ?string $localeFilter = null): array
    {
        $targets = [];
        foreach ($this->storeManager->getStores() as $store) {
            $theme = $store->isActive() ? $this->getStoreTheme($store) : null;
            if (!$theme) {
                continue;
            }
            $locale = (string)$this->scopeConfig->getValue(
                'general/locale/code',
                ScopeInterface::SCOPE_STORE,
                $store->getId()
            );
            if (($themeFilter && $theme->getThemePath() !== $themeFilter)
                || ($localeFilter && $locale !== $localeFilter)
            ) {
                continue;
            }
            $key = $theme->getThemePath() . '/' . $locale;
            $targets[$key] ??= $this->createTarget($theme, $locale);
            $targets[$key]['storeIds'][] = (int)$store->getId();
        }
        return array_values($targets);
    }

    /**
     * Theme of a store view.
     *
     * @param StoreInterface $store
     * @return ThemeInterface|null
     */
    private function getStoreTheme(StoreInterface $store): ?ThemeInterface
    {
        $themeId = $this->design->getConfigurationDesignTheme(self::AREA, ['store' => $store]);
        $theme = is_numeric($themeId)
            ? $this->themeProvider->getThemeById((int)$themeId)
            : $this->themeProvider->getThemeByFullPath(self::AREA . '/' . $themeId);
        return $theme && $theme->getId() ? $theme : null;
    }

    /**
     * New target for a theme/locale.
     *
     * @param ThemeInterface $theme
     * @param string $locale
     * @return array
     */
    private function createTarget(ThemeInterface $theme, string $locale): array
    {
        $dir = $this->getStaticDir($theme, $locale);
        return [
            'theme' => $theme,
            'locale' => $locale,
            'storeIds' => [],
            'deployed' => $this->file->isDirectory($dir),
            'requireJs' => $this->file->isFile($dir . '/requirejs-config.js')
                || $this->file->isFile($dir . '/requirejs-config.min.js'),
        ];
    }

    /**
     * Static content directory of a theme/locale.
     *
     * @param ThemeInterface $theme
     * @param string $locale
     * @return string
     */
    public function getStaticDir(ThemeInterface $theme, string $locale): string
    {
        return $this->directoryList->getPath(DirectoryList::STATIC_VIEW)
            . '/' . self::AREA . '/' . $theme->getThemePath() . '/' . $locale;
    }
}
