<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem\Driver\File;
use Magento\Framework\Phrase;
use Magento\Framework\Serialize\Serializer\Json;

/**
 * static-optimize.json in the Magento root, or the defaults.
 */
class PageConfig
{
    public const FILE = 'static-optimize.json';

    public const DEFAULT_PAGES = [
        'home' => ['default', 'cms_index_index', 'cms_page_view'],
        'category' => ['default', 'catalog_category_view', 'catalog_category_view_type_layered'],
        'product' => ['default', 'catalog_product_view', 'catalog_product_view_type_simple'],
        'product-configurable' => ['default', 'catalog_product_view', 'catalog_product_view_type_configurable'],
        'product-bundle' => ['default', 'catalog_product_view', 'catalog_product_view_type_bundle'],
        'product-grouped' => ['default', 'catalog_product_view', 'catalog_product_view_type_grouped'],
        'search' => ['default', 'catalogsearch_result_index'],
        'cart' => ['default', 'checkout_cart_index'],
        'checkout' => ['default', 'checkout_index_index'],
        'success' => ['default', 'checkout_onepage_success'],
        'login' => ['default', 'customer_account_login'],
        'account' => ['default', 'customer_account_index'],
    ];

    /**
     * @var DirectoryList
     */
    protected $directoryList;

    /**
     * @var Json
     */
    protected $json;

    /**
     * @var File
     */
    protected $file;

    /**
     * Inject dependencies.
     *
     * @param DirectoryList $directoryList
     * @param Json $json
     * @param File $file
     */
    public function __construct(
        DirectoryList $directoryList,
        Json $json,
        File $file
    ) {
        $this->directoryList = $directoryList;
        $this->json = $json;
        $this->file = $file;
    }

    /**
     * Absolute path of the config file.
     *
     * @return string
     */
    public function getPath(): string
    {
        return $this->directoryList->getRoot() . '/' . static::FILE;
    }

    /**
     * Whether the site has its own config file.
     *
     * @return bool
     */
    public function exists(): bool
    {
        return $this->file->isFile($this->getPath());
    }

    /**
     * Page types from the config file, or the defaults.
     *
     * @return array<string, string[]>
     * @throws LocalizedException when the file is not valid
     */
    public function getPages(): array
    {
        $data = $this->getData();
        if ($data === null) {
            return static::DEFAULT_PAGES;
        }
        $pages = $data['pages'] ?? null;
        if (!is_array($pages) || !$pages || $this->isList($pages)) {
            throw $this->error('"pages" must be an object of page type => list of layout handles');
        }
        foreach ($pages as $name => $handles) {
            $this->assertPageType((string)$name, $handles);
        }
        return $pages;
    }

    /**
     * Chunk size limit in KB (minChunk, maxChunk), 0 when not set.
     *
     * @param string $key
     * @return int
     * @throws LocalizedException when the value is not a whole number of KB >= 0
     */
    public function getChunkSize(string $key): int
    {
        $value = ($this->getData() ?? [])[$key] ?? 0;
        if (!is_int($value) || $value < 0) {
            throw $this->error('"%1" must be a whole number of KB, 0 or more', [$key]);
        }
        return $value;
    }

    /**
     * Module ids never bundled ("*" wildcard).
     *
     * @return string[]
     * @throws LocalizedException when the file is not valid
     */
    public function getExclude(): array
    {
        $exclude = ($this->getData() ?? [])['exclude'] ?? [];
        if (!is_array($exclude) || !$this->isList($exclude)) {
            throw $this->error('"exclude" must be a list of module ids');
        }
        foreach ($exclude as $id) {
            $this->assertModuleId($id, 'exclude');
        }
        return $exclude;
    }

    /**
     * Extra entry modules per page type.
     *
     * @param array $pages page types in use (page type => layout handles)
     * @return array<string, string[]>
     * @throws LocalizedException when the file is not valid
     */
    public function getEntries(array $pages): array
    {
        $entries = ($this->getData() ?? [])['entries'] ?? [];
        if (!is_array($entries) || ($entries && $this->isList($entries))) {
            throw $this->error('"entries" must be an object of page type => list of module ids');
        }
        foreach ($entries as $page => $ids) {
            if (!isset($pages[$page])) {
                throw $this->error('"entries" refers to page type "%1" which is not in "pages"', [$page]);
            }
            if (!is_array($ids) || !$this->isList($ids)) {
                throw $this->error('entries of "%1" must be a list of module ids', [$page]);
            }
            foreach ($ids as $id) {
                $this->assertModuleId($id, 'entries.' . $page);
            }
        }
        return $entries;
    }

    /**
     * Validate a page type.
     *
     * @param string $name
     * @param mixed $handles
     * @return void
     * @throws LocalizedException
     */
    protected function assertPageType(string $name, $handles): void
    {
        if (!preg_match('/^[a-z0-9][a-z0-9_-]*$/i', $name)) {
            throw $this->error('invalid page type name "%1" (letters, digits, - and _)', [$name]);
        }
        if (!is_array($handles) || !$handles || !$this->isList($handles)) {
            throw $this->error('page type "%1" needs a list of layout handles', [$name]);
        }
        foreach ($handles as $handle) {
            if (!is_string($handle) || !preg_match('/^[a-z0-9_]+$/', $handle)) {
                throw $this->error('page type "%1" has an invalid layout handle %2', [$name, json_encode($handle)]);
            }
        }
    }

    /**
     * Config file error.
     *
     * @param string $message
     * @param array $args values of %1, %2...
     * @return LocalizedException
     */
    protected function error(string $message, array $args = []): LocalizedException
    {
        return new LocalizedException(__('%1: %2', static::FILE, new Phrase($message, $args)));
    }

    /**
     * Validate a module id or pattern.
     *
     * @param mixed $id
     * @param string $key
     * @return void
     * @throws LocalizedException
     */
    protected function assertModuleId($id, string $key): void
    {
        if (!is_string($id) || !preg_match('#^[A-Za-z0-9_\-.*!/]+$#', $id)) {
            throw $this->error('invalid module id %1 in "%2"', [json_encode($id), $key]);
        }
    }

    /**
     * Decoded config file, null when there is none.
     *
     * @return array|null
     * @throws LocalizedException when the file is not valid JSON
     */
    protected function getData(): ?array
    {
        if (!$this->exists()) {
            return null;
        }
        try {
            $data = $this->json->unserialize($this->file->fileGetContents($this->getPath()));
        } catch (\InvalidArgumentException $e) {
            throw new LocalizedException(__('%1 is not valid JSON: %2', static::FILE, $e->getMessage()));
        }
        if (!is_array($data)) {
            throw new LocalizedException(__('%1 must contain a JSON object', static::FILE));
        }
        return $data;
    }

    /**
     * Writes the default config file.
     *
     * @param bool $overwrite
     * @return string path written
     * @throws LocalizedException when the file exists and $overwrite is false
     */
    public function writeDefault(bool $overwrite = false): string
    {
        if ($this->exists() && !$overwrite) {
            throw new LocalizedException(__('%1 already exists, use --force to overwrite it', $this->getPath()));
        }
        $content = json_encode(
            [
                'minChunk' => 0,
                'maxChunk' => 0,
                'exclude' => [],
                'entries' => (object)[],
                'pages' => static::DEFAULT_PAGES,
            ],
            JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
        ) . "\n";
        $this->file->filePutContents($this->getPath(), $content);
        return $this->getPath();
    }

    /**
     * Whether an array is a list (keys 0..n-1), like array_is_list() of PHP 8.1.
     *
     * @param array $array
     * @return bool
     */
    protected function isList(array $array): bool
    {
        return $array === [] || array_keys($array) === range(0, count($array) - 1);
    }
}
