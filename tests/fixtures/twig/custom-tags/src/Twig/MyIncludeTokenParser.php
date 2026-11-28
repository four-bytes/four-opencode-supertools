<?php

declare(strict_types=1);

namespace App\Twig;

use Twig\TokenParser\IncludeTokenParser;

final class MyIncludeTokenParser extends IncludeTokenParser
{
    public function getTag(): string
    {
        return 'my_include';
    }
}
