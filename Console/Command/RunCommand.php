<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Console\Command;

use Magento\Framework\Exception\LocalizedException;
use OOCS\RequireJsOptimize\Model\ContextBuilder;
use OOCS\RequireJsOptimize\Model\Engine;
use OOCS\RequireJsOptimize\Model\PageConfig;
use OOCS\RequireJsOptimize\Model\Sri;
use OOCS\RequireJsOptimize\Model\StaticVersion;
use OOCS\RequireJsOptimize\Model\TargetList;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputArgument;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * bin/magento static:optimize:run [build|check|clean]
 */
class RunCommand extends Command
{
    protected const EXIT_SUCCESS = 0;
    protected const EXIT_FAILURE = 1;
    protected const ACTIONS = ['build', 'check', 'clean'];

    /**
     * @var TargetList
     */
    protected $targetList;

    /**
     * @var ContextBuilder
     */
    protected $contextBuilder;

    /**
     * @var PageConfig
     */
    protected $pageConfig;

    /**
     * @var Engine
     */
    protected $engine;

    /**
     * @var StaticVersion
     */
    protected $staticVersion;

    /**
     * @var Sri
     */
    protected $sri;

    /**
     * Inject dependencies.
     *
     * @param TargetList $targetList
     * @param ContextBuilder $contextBuilder
     * @param PageConfig $pageConfig
     * @param Engine $engine
     * @param StaticVersion $staticVersion
     * @param Sri $sri
     * @param string|null $name
     */
    public function __construct(
        TargetList $targetList,
        ContextBuilder $contextBuilder,
        PageConfig $pageConfig,
        Engine $engine,
        StaticVersion $staticVersion,
        Sri $sri,
        ?string $name = null
    ) {
        $this->targetList = $targetList;
        $this->contextBuilder = $contextBuilder;
        $this->pageConfig = $pageConfig;
        $this->engine = $engine;
        $this->staticVersion = $staticVersion;
        $this->sri = $sri;
        parent::__construct($name);
    }

    /**
     * Define the command name, argument and options.
     *
     * @return void
     */
    protected function configure(): void
    {
        $this->setName('static:optimize:run')
            ->setDescription(
                'Bundle storefront RequireJS modules per page type (run after setup:static-content:deploy)'
            )
            ->addArgument('action', InputArgument::OPTIONAL, 'build | check | clean', 'build')
            ->addOption('theme', null, InputOption::VALUE_REQUIRED, 'Only this theme (Vendor/theme)')
            ->addOption('locale', null, InputOption::VALUE_REQUIRED, 'Only this locale (xx_XX)')
            ->addOption(
                'min-chunk',
                null,
                InputOption::VALUE_REQUIRED,
                'Shared chunks below this size (KB) merge into common (0 = never; default: minChunk of '
                . PageConfig::FILE . ', else 0)'
            )
            ->addOption(
                'max-chunk',
                null,
                InputOption::VALUE_REQUIRED,
                'Chunks above this source size (KB) are split into parts loaded together (0 = never; default:'
                . ' maxChunk of ' . PageConfig::FILE . ', else 0)'
            )
            ->addOption('json', null, InputOption::VALUE_REQUIRED, 'check: write the full report to this file')
            ->addOption('node', null, InputOption::VALUE_REQUIRED, 'Node.js binary', 'node')
            ->addOption(
                'no-version-refresh',
                null,
                InputOption::VALUE_NONE,
                'build/clean: keep the static content version (refresh it yourself, e.g. in the deploy pipeline)'
            );
        parent::configure();
    }

    /**
     * Run the engine for each theme/locale.
     *
     * @param InputInterface $input
     * @param OutputInterface $output
     * @return int
     */
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $action = (string)$input->getArgument('action');
        if (!in_array($action, static::ACTIONS, true)) {
            $output->writeln(
                sprintf('<error>Unknown action "%s", use %s</error>', $action, implode(' | ', static::ACTIONS))
            );
            return static::EXIT_FAILURE;
        }
        try {
            $config = $this->getConfig();
            $node = (string)$input->getOption('node');
            $this->engine->check($node);
            $targets = $this->targetList->get($input->getOption('theme'), $input->getOption('locale'));
            if (!$targets) {
                throw new LocalizedException(__('No active store view uses a matching frontend theme/locale.'));
            }
        } catch (LocalizedException $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return static::EXIT_FAILURE;
        }
        $output->writeln('<comment>page types from ' . ($this->pageConfig->exists()
            ? $this->pageConfig->getPath()
            : 'defaults (bin/magento static:optimize:init to customize)') . '</comment>');

        $results = array_map(
            function (array $target) use ($config, $node, $action, $input, $output) {
                return $this->runTarget($target, $config, $node, $action, $input, $output);
            },
            $targets
        );
        // checkout pages put integrity attributes on scripts: the edited requirejs-config.js needs its new hash
        $this->sri->store();
        // only when static files changed: a new version empties browser and CDN caches of all static files
        if ($action !== 'check' && in_array(true, $results, true) && !$input->getOption('no-version-refresh')) {
            $this->refreshStaticVersion($output);
        }
        return in_array(false, $results, true) ? static::EXIT_FAILURE : static::EXIT_SUCCESS;
    }

    /**
     * Config passed to the engine.
     *
     * @return array
     * @throws LocalizedException
     */
    protected function getConfig(): array
    {
        $pages = $this->pageConfig->getPages();
        return [
            'pages' => $pages,
            'exclude' => $this->pageConfig->getExclude(),
            'entries' => (object)$this->pageConfig->getEntries($pages),
            'minChunk' => $this->pageConfig->getChunkSize('minChunk'),
            'maxChunk' => $this->pageConfig->getChunkSize('maxChunk'),
        ];
    }

    /**
     * New static content version, so browsers and CDNs load the new requirejs-config.js.
     *
     * @param OutputInterface $output
     * @return void
     */
    protected function refreshStaticVersion(OutputInterface $output): void
    {
        // also names merged JS files (dev/js/merge_files): new pages get new ones with the new
        // requirejs-config.js, pages still cached keep loading the previous ones
        $version = $this->staticVersion->refresh();
        $output->writeln("<comment>Static content version is now {$version}:"
            . ' flush the full page cache and purge Varnish/CDN.</comment>');
        if (!$this->staticVersion->isSigned()) {
            $output->writeln('<comment>dev/static/sign is off: static URLs carry no version, browsers and CDNs'
                . ' may keep the old requirejs-config.js until their cache expires.</comment>');
        }
    }

    /**
     * Run the engine for one theme/locale.
     *
     * @param array $target
     * @param array $config
     * @param string $node
     * @param string $action
     * @param InputInterface $input
     * @param OutputInterface $output
     * @return bool|null false when the engine failed, null when skipped
     * @throws LocalizedException
     */
    protected function runTarget(
        array $target,
        array $config,
        string $node,
        string $action,
        InputInterface $input,
        OutputInterface $output
    ): ?bool {
        $themePath = $target['theme']->getThemePath();
        $label = $themePath . ' / ' . $target['locale'];
        if (!$target['deployed'] || !$target['requireJs']) {
            $reason = $target['deployed'] ? 'theme does not use RequireJS' : 'static content not deployed';
            $output->writeln("<comment>skip {$label}: {$reason}</comment>");
            return null;
        }
        [$success, $contextFile] = $this->engine->run(
            $node,
            $action,
            str_replace('/', '_', $themePath) . '-' . $target['locale'],
            $config + $this->contextBuilder->build($target),
            $this->getEngineArgs($action, $input, $output, $config),
            static function (string $data) use ($output) {
                $output->write($data);
            },
            $output->isVerbose()
        );
        // kept with -v for debugging
        if ($output->isVerbose()) {
            $output->writeln("<comment>context kept: {$contextFile}</comment>");
        }
        if ($success && $action !== 'check') {
            $this->sri->collect($this->targetList->getStaticDir($target['theme'], $target['locale']));
        }
        return $success;
    }

    /**
     * Engine arguments.
     *
     * @param string $action
     * @param InputInterface $input
     * @param OutputInterface $output
     * @param array $config
     * @return string[]
     */
    protected function getEngineArgs(
        string $action,
        InputInterface $input,
        OutputInterface $output,
        array $config
    ): array {
        $args = [];
        if ($action === 'build') {
            // command line first, then static-optimize.json
            $args = [
                '--min-chunk', (string)($input->getOption('min-chunk') ?? $config['minChunk']),
                '--max-chunk', (string)($input->getOption('max-chunk') ?? $config['maxChunk']),
            ];
        }
        if ($action === 'check' && $input->getOption('json')) {
            $args = ['--json', (string)$input->getOption('json')];
        }
        if ($output->isVerbose()) {
            $args[] = '--verbose';
        }
        return $args;
    }
}
