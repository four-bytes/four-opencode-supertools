<?php

namespace App\Docs;

use App\Helper\SomeHelper;

/**
 * Documented service.
 */
#[SomeAttribute]
class DocumentedService
{
    public function run(): SomeHelper
    {
        return new SomeHelper();
    }
}
