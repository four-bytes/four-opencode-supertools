<?php declare(strict_types=1);

namespace AlphaPlugin\Migration;

use Doctrine\DBAL\Connection;
use Shopware\Core\Framework\Migration\MigrationStep;

class Migration1700000000AddExample extends MigrationStep
{
    public function getCreationTimestamp(): int
    {
        return 1700000000;
    }

    public function update(Connection $connection): void
    {
    }

    public function updateDestructive(Connection $connection): void
    {
    }
}
