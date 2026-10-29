<?php
/**
 * Copyright © OOCS Commerce (https://www.oocscommerce.com).
 * See LICENSE.txt for license details.
 */
declare(strict_types=1);

namespace OOCS\RequireJsOptimize\Console\Command;

use Magento\Framework\Exception\LocalizedException;
use OOCS\RequireJsOptimize\Model\PageConfig;
use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Input\InputOption;
use Symfony\Component\Console\Output\OutputInterface;

/**
 * bin/magento static:optimize:init: writes the default static-optimize.json.
 */
class InitCommand extends Command
{
    /**
     * Inject dependencies.
     *
     * @param PageConfig $pageConfig
     * @param string|null $name
     */
    public function __construct(
        private readonly PageConfig $pageConfig,
        ?string $name = null
    ) {
        parent::__construct($name);
    }

    /**
     * Define the command name and options.
     *
     * @return void
     */
    protected function configure(): void
    {
        $this->setName('static:optimize:init')
            ->setDescription('Write ' . PageConfig::FILE . ' with the default page types to the Magento root')
            ->addOption('force', 'f', InputOption::VALUE_NONE, 'Overwrite an existing ' . PageConfig::FILE);
        parent::configure();
    }

    /**
     * Write the default config file.
     *
     * @param InputInterface $input
     * @param OutputInterface $output
     * @return int
     */
    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        try {
            $path = $this->pageConfig->writeDefault((bool)$input->getOption('force'));
        } catch (LocalizedException $e) {
            $output->writeln('<error>' . $e->getMessage() . '</error>');
            return Command::FAILURE;
        }
        $output->writeln("<info>Wrote {$path}</info>");
        $output->writeln('Add or remove page types there: "name": [layout handles of that page],'
            . ' then run bin/magento static:optimize:run');
        return Command::SUCCESS;
    }
}
