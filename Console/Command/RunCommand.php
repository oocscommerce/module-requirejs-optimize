<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Console\Command;

use Magento\Framework\App\Area;
use Magento\Framework\App\State;
use Magento\Framework\Exception\LocalizedException;
use OOCS\RequireJsOptimize\Model\ContextBuilder;
use OOCS\RequireJsOptimize\Model\Engine;
use OOCS\RequireJsOptimize\Model\PageConfig;
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
    private const ACTIONS = ['build', 'check', 'clean'];

    /**
     * Inject dependencies.
     *
     * @param TargetList $targetList
     * @param ContextBuilder $contextBuilder
     * @param PageConfig $pageConfig
     * @param State $appState
     * @param Engine $engine
     * @param StaticVersion $staticVersion
     * @param string|null $name
     */
    public function __construct(
        private readonly TargetList $targetList,
        private readonly ContextBuilder $contextBuilder,
        private readonly PageConfig $pageConfig,
        private readonly State $appState,
        private readonly Engine $engine,
        private readonly StaticVersion $staticVersion,
        ?string $name = null
    ) {
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
                'Shared chunks below this size (KB) merge into common (0 = never)',
                '0'
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
        if (!in_array($action, self::ACTIONS, true)) {
            $output->writeln(
                sprintf('<error>Unknown action "%s", use %s</error>', $action, implode(' | ', self::ACTIONS))
            );
            return Command::INVALID;
        }
        try {
            $config = $this->getConfig();
            $node = (string)$input->getOption('node');
            $this->engine->check($node);
            $this->setArea();
            $targets = $this->targetList->get($input->getOption('theme'), $input->getOption('locale'));
            if (!$targets) {
                throw new LocalizedException(__('No active store view uses a matching frontend theme/locale.'));
            }
        } catch (LocalizedException $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return Command::FAILURE;
        }
        $output->writeln('<comment>page types from ' . ($this->pageConfig->exists()
            ? $this->pageConfig->getPath()
            : 'defaults (bin/magento static:optimize:init to customize)') . '</comment>');

        $results = array_map(
            fn (array $target) => $this->runTarget($target, $config, $node, $action, $input, $output),
            $targets
        );
        // only when static files changed: a new version empties browser and CDN caches of all static files
        if ($action !== 'check' && in_array(true, $results, true) && !$input->getOption('no-version-refresh')) {
            $this->refreshStaticVersion($output);
        }
        return in_array(false, $results, true) ? Command::FAILURE : Command::SUCCESS;
    }

    /**
     * Config passed to the engine.
     *
     * @return array
     * @throws LocalizedException
     */
    private function getConfig(): array
    {
        $pages = $this->pageConfig->getPages();
        return [
            'pages' => $pages,
            'exclude' => $this->pageConfig->getExclude(),
            'entries' => (object)$this->pageConfig->getEntries($pages),
        ];
    }

    /**
     * New static content version, so browsers and CDNs load the new requirejs-config.js.
     *
     * @param OutputInterface $output
     * @return void
     */
    private function refreshStaticVersion(OutputInterface $output): void
    {
        if (!$this->staticVersion->isSigned()) {
            $output->writeln('<comment>dev/static/sign is off: browsers and CDNs may keep the old'
                . ' requirejs-config.js until their cache expires.</comment>');
            return;
        }
        $version = $this->staticVersion->refresh();
        $output->writeln("<comment>Static content version is now {$version}:"
            . ' flush the full page cache and purge Varnish/CDN.</comment>');
    }

    /**
     * Set frontend area.
     *
     * @return void
     * @throws LocalizedException
     */
    private function setArea(): void
    {
        try {
            $this->appState->getAreaCode();
        } catch (LocalizedException $e) {
            $this->appState->setAreaCode(Area::AREA_FRONTEND);
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
    private function runTarget(
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
            $this->getEngineArgs($action, $input, $output),
            static fn (string $data) => $output->write($data),
            $output->isVerbose()
        );
        // kept with -v for debugging
        if ($output->isVerbose()) {
            $output->writeln("<comment>context kept: {$contextFile}</comment>");
        }
        return $success;
    }

    /**
     * Engine arguments.
     *
     * @param string $action
     * @param InputInterface $input
     * @param OutputInterface $output
     * @return string[]
     */
    private function getEngineArgs(string $action, InputInterface $input, OutputInterface $output): array
    {
        $args = [];
        if ($action === 'build') {
            $args = ['--min-chunk', (string)$input->getOption('min-chunk')];
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
