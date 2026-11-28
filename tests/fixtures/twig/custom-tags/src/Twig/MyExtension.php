<?php

declare(strict_types=1);

namespace App\Twig;

use Twig\Extension\ExtensionInterface;

final class MyExtension implements ExtensionInterface
{
    public function getTokenParsers(): array
    {
        return [
            new MyExtendsTokenParser(),
            new MyIncludeTokenParser(),
            new MyOtherTokenParser(),
        ];
    }
}
