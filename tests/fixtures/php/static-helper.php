<?php

class StaticHelper
{
    public static function run(int $a): void
    {
        $b = $a * 2;
        $c = $b + 1;
        echo $c;
    }
}
