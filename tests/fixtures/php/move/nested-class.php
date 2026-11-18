<?php

namespace App\Nested;

class Outer
{
    public function make(): object
    {
        return new class {
        };
    }
}

function makeClass(): void
{
    class InsideFunction
    {
    }
}
