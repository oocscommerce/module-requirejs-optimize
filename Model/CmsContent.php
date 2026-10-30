<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Cms\Api\Data\BlockInterface;
use Magento\Cms\Api\Data\PageInterface;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\ResourceConnection;
use Magento\Framework\DB\Adapter\AdapterInterface;
use Magento\Framework\EntityManager\MetadataPool;
use Magento\Store\Model\ScopeInterface;

/**
 * CMS pages, blocks and widget instances per layout handle.
 */
class CmsContent
{
    protected const CMS_BLOCK_CLASS = '/Cms\\\\Block\\\\(Widget\\\\)?Block$/';
    protected const CMS_BLOCK_WIDGET = '/Cms\\\\Block\\\\Widget\\\\Block$/';

    /**
     * @var ResourceConnection
     */
    protected $resource;

    /**
     * @var ScopeConfigInterface
     */
    protected $scopeConfig;

    /**
     * @var MetadataPool
     */
    protected $metadataPool;

    /**
     * Inject dependencies.
     *
     * @param ResourceConnection $resource
     * @param ScopeConfigInterface $scopeConfig
     * @param MetadataPool $metadataPool
     */
    public function __construct(
        ResourceConnection $resource,
        ScopeConfigInterface $scopeConfig,
        MetadataPool $metadataPool
    ) {
        $this->resource = $resource;
        $this->scopeConfig = $scopeConfig;
        $this->metadataPool = $metadataPool;
    }

    /**
     * Blocks and HTML per layout handle.
     *
     * @param int $themeId
     * @param int[] $storeIds
     * @return array{byHandle: array, stats: array}
     */
    public function collect(int $themeId, array $storeIds): array
    {
        $connection = $this->resource->getConnection();
        $stores = array_merge([0], $storeIds);
        $blocks = $this->getBlocks($connection, $stores);
        $byHandle = [];
        $pages = $this->addPages($byHandle, $connection, $blocks, $stores, $storeIds[0]);
        $widgets = $this->addWidgets($byHandle, $connection, $blocks, $stores, $themeId);
        return [
            'byHandle' => $byHandle,
            'stats' => ['pages' => $pages, 'blocks' => (int)(count($blocks) / 2), 'widgets' => $widgets],
        ];
    }

    /**
     * Active CMS block content by id and identifier.
     *
     * @param AdapterInterface $connection
     * @param int[] $stores
     * @return array<string, string>
     */
    protected function getBlocks(AdapterInterface $connection, array $stores): array
    {
        // row_id on Adobe Commerce (content staging), block_id on Open Source
        $link = $this->metadataPool->getMetadata(BlockInterface::class)->getLinkField();
        $select = $connection->select()
            ->from(['b' => $this->resource->getTableName('cms_block')], ['block_id', 'identifier', 'content'])
            ->join(['s' => $this->resource->getTableName('cms_block_store')], "s.$link = b.$link", [])
            ->where('b.is_active = 1')
            ->where('s.store_id IN (?)', $stores);
        $blocks = [];
        foreach ($connection->fetchAll($select) as $row) {
            $blocks[(string)$row['block_id']] = (string)$row['content'];
            $blocks[(string)$row['identifier']] = (string)$row['content'];
        }
        return $blocks;
    }

    /**
     * Add active CMS pages.
     *
     * @param array $byHandle
     * @param AdapterInterface $connection
     * @param array $blocks CMS block content by id and identifier
     * @param int[] $stores
     * @param int $storeId store view whose home / 404 page settings apply
     * @return int number of pages
     */
    protected function addPages(
        array &$byHandle,
        AdapterInterface $connection,
        array $blocks,
        array $stores,
        int $storeId
    ): int {
        $home = $this->getPageIdentifier('web/default/cms_home_page', $storeId);
        $noRoute = $this->getPageIdentifier('web/default/cms_no_route', $storeId);
        $link = $this->metadataPool->getMetadata(PageInterface::class)->getLinkField();
        $select = $connection->select()
            ->from(['p' => $this->resource->getTableName('cms_page')], ['identifier', 'content'])
            ->join(['s' => $this->resource->getTableName('cms_page_store')], "s.$link = p.$link", [])
            ->where('p.is_active = 1')
            ->where('s.store_id IN (?)', $stores)
            ->group('p.page_id');
        $pages = $connection->fetchAll($select);
        foreach ($pages as $page) {
            $handle = 'cms_page_view';
            if ($page['identifier'] === $home) {
                $handle = 'cms_index_index';
            } elseif ($page['identifier'] === $noRoute) {
                $handle = 'cms_noroute_index';
            }
            $this->addContent($byHandle, $handle, (string)$page['content'], $blocks);
        }
        return count($pages);
    }

    /**
     * Add widget instances of the theme.
     *
     * @param array $byHandle
     * @param AdapterInterface $connection
     * @param array $blocks CMS block content by id and identifier
     * @param int[] $stores
     * @param int $themeId
     * @return int number of widget instances
     */
    protected function addWidgets(
        array &$byHandle,
        AdapterInterface $connection,
        array $blocks,
        array $stores,
        int $themeId
    ): int {
        $select = $connection->select()
            ->from(
                ['w' => $this->resource->getTableName('widget_instance')],
                ['instance_type', 'widget_parameters', 'store_ids']
            )
            ->join(
                ['p' => $this->resource->getTableName('widget_instance_page')],
                'p.instance_id = w.instance_id',
                ['layout_handle', 'page_template']
            )
            ->where('w.theme_id = ?', $themeId);
        $widgets = 0;
        foreach ($connection->fetchAll($select) as $row) {
            if (!array_intersect(array_map('intval', explode(',', (string)$row['store_ids'])), $stores)) {
                continue;
            }
            $widgets++;
            $params = json_decode((string)$row['widget_parameters'], true) ?: [];
            $handle = $row['layout_handle'] ?: 'default';
            if (!preg_match(static::CMS_BLOCK_WIDGET, $row['instance_type'])) {
                $template = $params['template'] ?? ($row['page_template'] ?: null);
                $this->addBlock($byHandle, $handle, $row['instance_type'], $template);
            } elseif (isset($blocks[(string)($params['block_id'] ?? '')])) {
                $this->addContent($byHandle, $handle, $blocks[(string)$params['block_id']], $blocks);
            }
        }
        return $widgets;
    }

    /**
     * Add HTML and its directive blocks, CMS blocks expanded.
     *
     * @param array $byHandle
     * @param string $handle
     * @param string $content
     * @param array $blocks CMS block content by id and identifier
     * @param array $seen CMS blocks already expanded (recursion guard)
     * @return void
     */
    protected function addContent(
        array &$byHandle,
        string $handle,
        string $content,
        array $blocks,
        array $seen = []
    ): void {
        if (!isset($byHandle[$handle])) {
            $byHandle[$handle] = ['blocks' => [], 'html' => []];
        }
        $byHandle[$handle]['html'][] = $content;
        foreach ($this->parseDirectives($content) as $params) {
            $class = $params['type'] ?? $params['class'] ?? null;
            $blockId = $params['block_id'] ?? $params['id'] ?? null;
            if ($class && !preg_match(static::CMS_BLOCK_CLASS, $class)) {
                $this->addBlock($byHandle, $handle, $class, $params['template'] ?? null);
            } elseif ($blockId !== null && isset($blocks[$blockId]) && !isset($seen[$blockId])) {
                $this->addContent($byHandle, $handle, $blocks[$blockId], $blocks, $seen + [$blockId => true]);
            }
        }
    }

    /**
     * Add a block class to a layout handle.
     *
     * @param array $byHandle
     * @param string $handle
     * @param string $class
     * @param string|null $template
     * @return void
     */
    protected function addBlock(array &$byHandle, string $handle, string $class, ?string $template): void
    {
        if (!isset($byHandle[$handle])) {
            $byHandle[$handle] = ['blocks' => [], 'html' => []];
        }
        $byHandle[$handle]['blocks'][] = ['class' => $class, 'template' => $template];
    }

    /**
     * CMS page identifier from an "identifier|id" setting.
     *
     * @param string $path
     * @param int $storeId
     * @return string
     */
    protected function getPageIdentifier(string $path, int $storeId): string
    {
        return (string)strtok((string)$this->scopeConfig->getValue($path, ScopeInterface::SCOPE_STORE, $storeId), '|');
    }

    /**
     * Parameters of {{widget}} / {{block}} directives.
     *
     * @param string $content
     * @return array<int, array<string, string>>
     */
    protected function parseDirectives(string $content): array
    {
        $out = [];
        preg_match_all('/\{\{(?:widget|block)\s+([^}]*)\}\}/', $content, $directives);
        foreach ($directives[1] as $body) {
            preg_match_all('/(\w+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')/', $body, $m, PREG_SET_ORDER);
            $params = [];
            foreach ($m as $p) {
                $params[$p[1]] = str_replace('\\\\', '\\', $p[2] !== '' ? $p[2] : ($p[3] ?? ''));
            }
            $out[] = $params;
        }
        return $out;
    }
}
