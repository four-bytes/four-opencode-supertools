<?php

namespace App\Service;

class First
{
    private string $name = 'first';

    public function processOrder(): void
    {
        $this->processOrder();
    }
}

class Second
{
    private string $name = 'second';

    public function processOrder(): void
    {
    }
}

function processOrder(): void
{
}
