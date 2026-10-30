<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Composer\Autoload\ClassLoader;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Component\ComponentRegistrar;
use Magento\Framework\Component\ComponentRegistrarInterface;
use Magento\Framework\Filesystem\Driver\File;
use Magento\Framework\Module\ModuleListInterface;
use Magento\Framework\View\Design\ThemeInterface;
use Magento\Framework\View\Layout\File\Collector\Aggregated as LayoutFileCollector;
use Magento\Store\Model\ScopeInterface;

/**
 * Site context for the engine: modules, themes, layout files, config, CMS content.
 */
class ContextBuilder
{
    /**
     * @var TargetList
     */
    protected $targetList;

    /**
     * @var ScopeConfigInterface
     */
    protected $scopeConfig;

    /**
     * @var ModuleListInterface
     */
    protected $moduleList;

    /**
     * @var ComponentRegistrarInterface
     */
    protected $componentRegistrar;

    /**
     * @var LayoutFileCollector
     */
    protected $layoutFileCollector;

    /**
     * @var CmsContent
     */
    protected $cmsContent;

    /**
     * @var DirectoryList
     */
    protected $directoryList;

    /**
     * @var File
     */
    protected $file;

    /**
     * Inject dependencies.
     *
     * @param TargetList $targetList
     * @param ScopeConfigInterface $scopeConfig
     * @param ModuleListInterface $moduleList
     * @param ComponentRegistrarInterface $componentRegistrar
     * @param LayoutFileCollector $layoutFileCollector
     * @param CmsContent $cmsContent
     * @param DirectoryList $directoryList
     * @param File $file
     */
    public function __construct(
        TargetList $targetList,
        ScopeConfigInterface $scopeConfig,
        ModuleListInterface $moduleList,
        ComponentRegistrarInterface $componentRegistrar,
        LayoutFileCollector $layoutFileCollector,
        CmsContent $cmsContent,
        DirectoryList $directoryList,
        File $file
    ) {
        $this->targetList = $targetList;
        $this->scopeConfig = $scopeConfig;
        $this->moduleList = $moduleList;
        $this->componentRegistrar = $componentRegistrar;
        $this->layoutFileCollector = $layoutFileCollector;
        $this->cmsContent = $cmsContent;
        $this->directoryList = $directoryList;
        $this->file = $file;
    }

    /**
     * Context JSON for one theme/locale.
     *
     * @param array $target one item of getTargets()
     * @return array
     */
    public function build(array $target): array
    {
        /** @var ThemeInterface $theme */
        $theme = $target['theme'];
        $storeId = $target['storeIds'][0];

        $modules = [];
        foreach ($this->moduleList->getNames() as $name) {
            $path = $this->componentRegistrar->getPath(ComponentRegistrar::MODULE, $name);
            if ($path) {
                $modules[] = [$name, $path];
            }
        }

        $chain = [];
        for ($t = $theme; $t; $t = $t->getParentTheme()) {
            $chain[] = [
                'code' => $t->getThemePath(),
                'dir' => $this->componentRegistrar->getPath(ComponentRegistrar::THEME, $t->getFullPath()),
            ];
        }

        $layoutFiles = [];
        foreach ($this->layoutFileCollector->getFiles($theme, '*.xml') as $file) {
            $layoutFiles[preg_replace('#^.*/|\\.xml$#', '', $file->getFilename())][] = $file->getFilename();
        }

        return [
            'root' => $this->directoryList->getRoot(),
            'theme' => $theme->getThemePath(),
            'locale' => $target['locale'],
            'storeIds' => $target['storeIds'],
            'staticDir' => $this->targetList->getStaticDir($theme, $target['locale']),
            'modules' => $modules,
            'themeChain' => $chain,
            'layoutFiles' => $layoutFiles,
            'ifconfig' => $this->getIfconfigValues($layoutFiles, $target['storeIds']),
            'psr4' => $this->getPsr4(),
            'jsFlags' => [
                'dev/js/enable_js_bundling' => $this->isSetFlag('dev/js/enable_js_bundling', $storeId),
                'dev/js/merge_files' => $this->isSetFlag('dev/js/merge_files', $storeId),
                'dev/js/minify_files' => $this->isSetFlag('dev/js/minify_files', $storeId),
            ],
            'cms' => $this->cmsContent->collect((int)$theme->getId(), $target['storeIds']),
        ];
    }

    /**
     * Ifconfig flags of the layout files: true/false, null when store views differ.
     *
     * @param array $layoutFiles handle => layout files
     * @param int[] $storeIds
     * @return array<string, bool|null>
     */
    protected function getIfconfigValues(array $layoutFiles, array $storeIds): array
    {
        $paths = [];
        foreach ($layoutFiles as $files) {
            foreach ($files as $file) {
                if (preg_match_all('/\bifconfig="([^"]+)"/', $this->file->fileGetContents($file), $m)) {
                    $paths += array_fill_keys($m[1], true);
                }
            }
        }
        $values = [];
        foreach (array_keys($paths) as $path) {
            $flags = array_unique(array_map(function ($storeId) use ($path) {
                return $this->isSetFlag($path, $storeId);
            }, $storeIds));
            $values[$path] = count($flags) === 1 ? reset($flags) : null;
        }
        return $values;
    }

    /**
     * Flag at store scope.
     *
     * @param string $path
     * @param int $storeId
     * @return bool
     */
    protected function isSetFlag(string $path, int $storeId): bool
    {
        return $this->scopeConfig->isSetFlag($path, ScopeInterface::SCOPE_STORE, $storeId);
    }

    /**
     * Composer PSR-4 prefixes, longest first.
     *
     * @return array<int, array{0: string, 1: string}>
     */
    protected function getPsr4(): array
    {
        $out = [];
        foreach ($this->getClassLoaders() as $loader) {
            foreach ($loader->getPrefixesPsr4() as $prefix => $dirs) {
                foreach ($dirs as $dir) {
                    $out[] = [$prefix, $this->file->getRealPath($dir) ?: $dir];
                }
            }
        }
        usort($out, static function ($a, $b) {
            return strlen($b[0]) <=> strlen($a[0]);
        });
        return $out;
    }

    /**
     * Composer class loaders (getRegisteredLoaders() exists from Composer 2 only).
     *
     * @return ClassLoader[]
     */
    protected function getClassLoaders(): array
    {
        if (method_exists(ClassLoader::class, 'getRegisteredLoaders')) {
            return ClassLoader::getRegisteredLoaders();
        }
        $loaders = [];
        foreach (spl_autoload_functions() ?: [] as $function) {
            if (is_array($function) && $function[0] instanceof ClassLoader) {
                $loaders[] = $function[0];
            }
        }
        return $loaders;
    }
}
