<?php

declare(strict_types=1);

namespace App\Twig;

use Twig\TokenParser\ExtendsTokenParser;

final class MyExtendsTokenParser extends ExtendsTokenParser
{
    public function getTag(): string
    {
        return 'my_extends';
    }
}
