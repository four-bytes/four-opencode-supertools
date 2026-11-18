<?php

namespace App;

class Widget
{
    private string $name = 'x';

    public function getName(): string
    {
        return $this->name;
    }
}
