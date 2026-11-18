<?php

class BadStatic
{
    public static function run(): void
    {
        $this->doThing();
    }

    private function doThing(): void
    {
    }
}
