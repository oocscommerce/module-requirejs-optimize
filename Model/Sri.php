<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Csp\Model\SubresourceIntegrity\HashGenerator;
use Magento\Csp\Model\SubresourceIntegrityCollector;
use Magento\Csp\Model\SubresourceIntegrityFactory;
use Magento\Csp\Plugin\StoreAssetIntegrityHashes;
use Magento\Deploy\Service\DeployStaticContent;
use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Filesystem\Driver\File;
use Magento\Framework\ObjectManagerInterface;

/**
 * Subresource integrity hashes (Magento_Csp, 2.4.7+) of the files a build changes.
 *
 * Stored the way setup:static-content:deploy stores them: collected, then saved by the core plugin,
 * which picks the storage of the Magento version (cache per area, or sri-hashes.json per theme/locale).
 * The Csp classes are created through the object manager: Magento before 2.4.7 has no SRI.
 */
class Sri
{
    // ::class does not load the class: fine on Magento without them
    protected const COLLECTOR = SubresourceIntegrityCollector::class;
    protected const FACTORY = SubresourceIntegrityFactory::class;
    protected const HASH_GENERATOR = HashGenerator::class;
    protected const STORE_PLUGIN = StoreAssetIntegrityHashes::class;
    protected const CONFIG_FILES = ['requirejs-config.js', 'requirejs-config.min.js'];
    protected const MANIFEST = 'rjs-optimize/manifest.json';

    /**
     * @var ObjectManagerInterface
     */
    protected $objectManager;

    /**
     * @var DirectoryList
     */
    protected $directoryList;

    /**
     * @var File
     */
    protected $file;

    /**
     * @var bool
     */
    protected $collected = false;

    /**
     * Inject dependencies.
     *
     * @param ObjectManagerInterface $objectManager
     * @param DirectoryList $directoryList
     * @param File $file
     */
    public function __construct(
        ObjectManagerInterface $objectManager,
        DirectoryList $directoryList,
        File $file
    ) {
        $this->objectManager = $objectManager;
        $this->directoryList = $directoryList;
        $this->file = $file;
    }

    /**
     * Whether this Magento has subresource integrity.
     *
     * @return bool
     */
    public function isAvailable(): bool
    {
        foreach ([static::COLLECTOR, static::FACTORY, static::HASH_GENERATOR, static::STORE_PLUGIN] as $class) {
            if (!class_exists($class)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Collects the hashes of requirejs-config.js and the chunks of a theme/locale.
     *
     * @param string $staticDir
     * @return void
     */
    public function collect(string $staticDir): void
    {
        if (!$this->isAvailable()) {
            return;
        }
        $collector = $this->objectManager->get(static::COLLECTOR);
        $factory = $this->objectManager->get(static::FACTORY);
        $hashGenerator = $this->objectManager->get(static::HASH_GENERATOR);
        $root = $this->directoryList->getPath(DirectoryList::STATIC_VIEW) . '/';
        foreach ($this->getChangedFiles($staticDir) as $file) {
            $collector->collect($factory->create(['data' => [
                'hash' => $hashGenerator->generate($this->file->fileGetContents($file)),
                // relative to pub/static, as Magento keys them: frontend/Vendor/theme/locale/...
                'path' => substr($file, strlen($root)),
            ]]));
            $this->collected = true;
        }
    }

    /**
     * Saves the collected hashes with the core plugin that runs after setup:static-content:deploy.
     *
     * @return void
     */
    public function store(): void
    {
        if (!$this->collected) {
            return;
        }
        $this->objectManager->get(static::STORE_PLUGIN)->afterDeploy(
            $this->objectManager->get(DeployStaticContent::class),
            null,
            []
        );
        $this->collected = false;
    }

    /**
     * Files of a static dir the build changes: requirejs-config and chunks (current and previous build).
     *
     * @param string $staticDir
     * @return string[]
     */
    protected function getChangedFiles(string $staticDir): array
    {
        $files = static::CONFIG_FILES;
        $manifest = $staticDir . '/' . static::MANIFEST;
        if ($this->file->isFile($manifest)) {
            $data = json_decode($this->file->fileGetContents($manifest), true) ?: [];
            foreach (array_merge($data['chunks'] ?? [], $data['previous'] ?? []) as $chunk) {
                $files[] = is_array($chunk) ? $chunk['file'] : $chunk;
            }
        }
        $out = [];
        foreach (array_unique($files) as $rel) {
            if ($this->file->isFile($staticDir . '/' . $rel)) {
                $out[] = $staticDir . '/' . $rel;
            }
        }
        return $out;
    }
}
