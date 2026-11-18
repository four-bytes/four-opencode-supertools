<?php

namespace App\Thing;

class Referencer
{
    public function make(): Helper
    {
        return new Helper();
    }
}
