<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Model;

use Magento\Framework\App\Filesystem\DirectoryList;
use Magento\Framework\Component\ComponentRegistrar;
use Magento\Framework\Component\ComponentRegistrarInterface;
use Magento\Framework\Exception\LocalizedException;
use Magento\Framework\Filesystem\Driver\File;
use Symfony\Component\Process\Process;

/**
 * Runs the Node engine shipped in tools/ on a site context file.
 */
class Engine
{
    public const MIN_NODE_MAJOR = 18;
    protected const SCRIPT = 'rjs-optimize.js';
    protected const TMP_DIR = 'oocs_requirejsoptimize';

    /**
     * @var DirectoryList
     */
    protected $directoryList;

    /**
     * @var File
     */
    protected $file;

    /**
     * @var ComponentRegistrarInterface
     */
    protected $componentRegistrar;

    /**
     * Inject dependencies.
     *
     * @param DirectoryList $directoryList
     * @param File $file
     * @param ComponentRegistrarInterface $componentRegistrar
     */
    public function __construct(
        DirectoryList $directoryList,
        File $file,
        ComponentRegistrarInterface $componentRegistrar
    ) {
        $this->directoryList = $directoryList;
        $this->file = $file;
        $this->componentRegistrar = $componentRegistrar;
    }

    /**
     * Check Node.js version and engine build.
     *
     * @param string $node Node.js binary
     * @return void
     * @throws LocalizedException
     */
    public function check(string $node): void
    {
        $process = new Process([$node, '--version']);
        $process->run();
        if (!$process->isSuccessful()) {
            throw new LocalizedException(__(
                'Node.js not found (%1). Install Node.js %2+ or pass --node=/path/to/node.',
                $node,
                static::MIN_NODE_MAJOR
            ));
        }
        $version = trim($process->getOutput());
        if ((int)ltrim($version, 'v') < static::MIN_NODE_MAJOR) {
            throw new LocalizedException(__('Node.js %1+ is required, found %2.', static::MIN_NODE_MAJOR, $version));
        }
        if (!$this->file->isFile($this->getDir() . '/dist/' . static::SCRIPT)
            && !$this->file->isDirectory($this->getDir() . '/node_modules')
        ) {
            throw new LocalizedException(__('Engine not built: run "npm ci && npm run dist" in %1', $this->getDir()));
        }
    }

    /**
     * Run the engine on a context, streaming its output.
     *
     * @param string $node Node.js binary
     * @param string $action build | check | clean
     * @param string $name context file name, unique per theme/locale
     * @param array $context
     * @param string[] $args extra engine arguments
     * @param callable $write receives each chunk of engine output
     * @param bool $keep keep the context file (debugging)
     * @return array{0: bool, 1: string} success, context file
     * @throws LocalizedException
     */
    public function run(
        string $node,
        string $action,
        string $name,
        array $context,
        array $args,
        callable $write,
        bool $keep
    ): array {
        $dir = $this->directoryList->getPath(DirectoryList::TMP) . '/' . static::TMP_DIR;
        $this->file->createDirectory($dir);
        $contextFile = $dir . '/context-' . $name . '.json';
        $this->file->filePutContents($contextFile, json_encode($context, JSON_UNESCAPED_SLASHES));

        $process = new Process(
            array_merge([$node, $this->getScript(), $action, '--context', $contextFile], $args),
            $this->directoryList->getRoot(),
            null,
            null,
            null
        );
        try {
            $process->start();
            foreach ($process as $data) {
                $write($data);
            }
        } finally {
            // holds CMS content and store config: removed even when the process fails to start or run
            if (!$keep) {
                $this->file->deleteFile($contextFile);
            }
        }
        return [$process->isSuccessful(), $contextFile];
    }

    /**
     * Engine directory.
     *
     * @return string
     */
    protected function getDir(): string
    {
        return $this->componentRegistrar->getPath(ComponentRegistrar::MODULE, 'OOCS_RequireJsOptimize') . '/tools';
    }

    /**
     * Engine script: dist build, else sources (need npm ci).
     *
     * @return string
     */
    protected function getScript(): string
    {
        $dist = $this->getDir() . '/dist/' . static::SCRIPT;
        return $this->file->isFile($dist) ? $dist : $this->getDir() . '/bin/' . static::SCRIPT;
    }
}
