<?php

declare(strict_types=1);

namespace App\Service;

use App\Helper\SomeHelper;
use App\Unused\Thing;

class MovedService
{
    public function run(): void
    {
        $helper = new SomeHelper();
    }
}
