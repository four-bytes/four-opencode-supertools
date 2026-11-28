<?php

declare(strict_types=1);

namespace App\Twig;

use Twig\TokenParser\AbstractTokenParser;

final class MyOtherTokenParser extends AbstractTokenParser
{
    public function getTag(): string
    {
        return 'my_other';
    }
}
