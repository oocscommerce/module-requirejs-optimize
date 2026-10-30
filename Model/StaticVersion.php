<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Deploy\Console\DeployStaticOptions;
use Magento\Deploy\Service\DeployStaticContent;
use Magento\Framework\App\Config\ScopeConfigInterface;
use Magento\Framework\App\View\Deployment\Version\StorageInterface;

/**
 * Static content version (pub/static/deployed_version.txt).
 */
class StaticVersion
{
    /**
     * @var DeployStaticContent
     */
    protected $deployStaticContent;

    /**
     * @var StorageInterface
     */
    protected $storage;

    /**
     * @var ScopeConfigInterface
     */
    protected $scopeConfig;

    /**
     * Inject dependencies.
     *
     * @param DeployStaticContent $deployStaticContent
     * @param StorageInterface $storage
     * @param ScopeConfigInterface $scopeConfig
     */
    public function __construct(
        DeployStaticContent $deployStaticContent,
        StorageInterface $storage,
        ScopeConfigInterface $scopeConfig
    ) {
        $this->deployStaticContent = $deployStaticContent;
        $this->storage = $storage;
        $this->scopeConfig = $scopeConfig;
    }

    /**
     * Whether static URLs carry the version (dev/static/sign).
     *
     * @return bool
     */
    public function isSigned(): bool
    {
        return $this->scopeConfig->isSetFlag('dev/static/sign');
    }

    /**
     * New version, as setup:static-content:deploy --refresh-content-version-only does.
     *
     * @return string
     */
    public function refresh(): string
    {
        $this->deployStaticContent->deploy([DeployStaticOptions::REFRESH_CONTENT_VERSION_ONLY => true]);
        return (string)$this->storage->load();
    }
}
